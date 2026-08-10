import { describe, expect, it } from 'vitest'
import { toAppSessionId } from '@/agent/shared/agentSessionIds'
import {
  advanceRequestSequence,
  bindActiveRequestContract,
  createLoopRun,
  enterLogicalRound,
  enterPhysicalAttempt
} from '@/agent/deepchat/loop/loopRun'
import { POSIX_COMMAND_SHELL } from '../../../../helpers/commandShell'

function createRun(sessionId: string, initialRequestSeq = 0) {
  return createLoopRun({
    runId: `${sessionId}:1`,
    sessionId: toAppSessionId(sessionId),
    messageId: `${sessionId}-message`,
    abortController: new AbortController(),
    messages: [{ role: 'user', content: sessionId }],
    streamState: { blocks: [] as string[] },
    resources: {
      toolDefinitions: [],
      activeSkillNames: [`${sessionId}-skill`],
      commandShell: POSIX_COMMAND_SHELL
    },
    initialRequestSeq,
    startedAt: 100
  })
}

describe('LoopRun', () => {
  it.each([
    ['missing', { toolDefinitions: [], activeSkillNames: [] }],
    [
      'contradictory',
      {
        toolDefinitions: [],
        activeSkillNames: [],
        commandShell: {
          ...POSIX_COMMAND_SHELL,
          dialect: 'powershell'
        }
      }
    ]
  ] as const)('rejects a %s command shell contract', (_kind, resources) => {
    expect(() =>
      createLoopRun({
        runId: 'invalid-shell',
        sessionId: toAppSessionId('session'),
        messageId: 'message',
        abortController: new AbortController(),
        messages: [],
        streamState: {},
        resources: resources as never
      })
    ).toThrow()
  })

  it('keeps mutable turn state isolated between sessions', () => {
    const first = createRun('first')
    const second = createRun('second')

    first.messages.push({ role: 'assistant', content: 'first response' })
    first.streamState.blocks.push('first block')
    first.resources.activeSkillNames.push('first-extra-skill')
    first.providerRecovery.contextOverflowHandoffAttempted = true
    advanceRequestSequence(first)
    enterLogicalRound(first)
    enterPhysicalAttempt(first)

    expect(second.messages).toEqual([{ role: 'user', content: 'second' }])
    expect(second.streamState.blocks).toEqual([])
    expect(second.resources.activeSkillNames).toEqual(['second-skill'])
    expect(second.providerRecovery).toEqual({
      contextOverflowHandoffAttempted: false,
      strictProviderOverflowRetryUsed: false
    })
    expect(second.initialRequestSeq).toBe(0)
    expect(second.logicalRound).toBe(0)
    expect(second.requestSeq).toBe(0)
    expect(second.physicalAttempt).toBe(0)
  })

  it('advances request and physical attempts independently from logical rounds', () => {
    const run = createRun('session', 4)

    expect(enterLogicalRound(run)).toBe(1)
    expect(advanceRequestSequence(run)).toBe(5)
    expect(enterPhysicalAttempt(run)).toBe(1)
    expect(enterPhysicalAttempt(run)).toBe(2)
    expect(advanceRequestSequence(run)).toBe(6)
    expect(run.physicalAttempt).toBe(0)
    expect(enterPhysicalAttempt(run)).toBe(1)

    expect(run.logicalRound).toBe(1)
    expect(run.initialRequestSeq).toBe(4)
    expect(run.requestSeq).toBe(6)
    expect(run.physicalAttempt).toBe(1)
  })

  it('binds one request-scoped contract and clears it before the next request', () => {
    const run = createRun('session')
    const requestSeq = advanceRequestSequence(run)
    const executionContract = {
      request: {
        sessionId: run.sessionId,
        messageId: run.messageId,
        runId: run.runId,
        requestSeq
      }
    } as any

    const binding = bindActiveRequestContract(run, requestSeq, executionContract)

    expect(binding.executionContract).toBe(executionContract)
    expect(run.activeRequestContract).toBe(binding)
    expect(Object.isFrozen(binding)).toBe(true)
    enterPhysicalAttempt(run)
    expect(run.activeRequestContract).toBe(binding)
    advanceRequestSequence(run)
    expect(run.activeRequestContract).toBeNull()
  })

  it('rejects stale or cross-run execution contract bindings', () => {
    const run = createRun('session')
    const requestSeq = advanceRequestSequence(run)
    const contract = (overrides: Record<string, unknown> = {}) =>
      ({
        request: {
          sessionId: run.sessionId,
          messageId: run.messageId,
          runId: run.runId,
          requestSeq,
          ...overrides
        }
      }) as any

    expect(() => bindActiveRequestContract(run, requestSeq + 1, null)).toThrow(/request sequence/)
    expect(() => bindActiveRequestContract(run, requestSeq, contract({ runId: 'other' }))).toThrow(
      /Loop Run/
    )
  })

  it('restores only valid persisted logical rounds', () => {
    expect(
      createLoopRun({
        runId: 'restored',
        sessionId: toAppSessionId('session'),
        messageId: 'message',
        abortController: new AbortController(),
        messages: [],
        streamState: {},
        resources: { toolDefinitions: [], activeSkillNames: [], commandShell: POSIX_COMMAND_SHELL },
        initialLogicalRound: 3
      }).logicalRound
    ).toBe(3)

    expect(
      createLoopRun({
        runId: 'invalid',
        sessionId: toAppSessionId('session'),
        messageId: 'message',
        abortController: new AbortController(),
        messages: [],
        streamState: {},
        resources: { toolDefinitions: [], activeSkillNames: [], commandShell: POSIX_COMMAND_SHELL },
        initialLogicalRound: 1.5
      }).logicalRound
    ).toBe(0)
  })

  it('retains the exact immutable prompt assembly on the run path', () => {
    const promptAssembly = Object.freeze({
      prompt: 'system prompt',
      sections: Object.freeze([
        Object.freeze({
          kind: 'configured_prompt' as const,
          sourceRef: 'session:generation-settings.system-prompt',
          inclusion: 'included' as const,
          contentHash: 'a'.repeat(64),
          content: 'system prompt'
        })
      ])
    })
    const run = createLoopRun({
      runId: 'run',
      sessionId: toAppSessionId('session'),
      messageId: 'message',
      abortController: new AbortController(),
      messages: [{ role: 'system', content: promptAssembly.prompt }],
      streamState: {},
      resources: {
        toolDefinitions: [],
        activeSkillNames: [],
        promptAssembly,
        commandShell: POSIX_COMMAND_SHELL
      }
    })

    expect(run.resources.promptAssembly).toBe(promptAssembly)
  })

  it('fails explicitly instead of wrapping an exhausted request sequence', () => {
    const run = createRun('session', Number.MAX_SAFE_INTEGER)

    expect(() => advanceRequestSequence(run)).toThrow('Provider request sequence is exhausted.')
    expect(run.requestSeq).toBe(Number.MAX_SAFE_INTEGER)
  })
})
