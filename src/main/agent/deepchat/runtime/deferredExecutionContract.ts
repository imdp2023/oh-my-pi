import type {
  DeepChatExecutionContract
} from '@shared/types/execution-contract'
import type { TapeViewManifestReader } from '@/tape/ports/capabilities'
import {
  ExecutionContractDispatchError,
  executionContractMatchesBinding,
  parseExecutionContractBinding,
  restoreExecutionContract
} from '@/tape/domain/executionContract'
import { verifyTapeViewManifestHash } from '@/tape/domain/viewManifest'

export interface DeferredExecutionContractResolutionInput {
  sessionId: string
  messageId: string
  rawBinding: unknown
  runtimeContract?: DeepChatExecutionContract
  viewManifests: Pick<TapeViewManifestReader, 'listViewManifestsByMessage'>
}

export function resolveDeferredExecutionContract(
  input: DeferredExecutionContractResolutionInput
): DeepChatExecutionContract | undefined {
  const { sessionId, messageId, rawBinding, runtimeContract, viewManifests } = input
  if (rawBinding === undefined) {
    if (runtimeContract) {
      throw new ExecutionContractDispatchError(
        'Paused tool dispatch is missing its durable ExecutionContract binding.',
        'invalid_contract'
      )
    }
    return undefined
  }
  const binding = parseExecutionContractBinding(rawBinding)
  if (!binding) {
    throw new ExecutionContractDispatchError(
      'Paused tool dispatch has an invalid ExecutionContract binding.',
      'invalid_contract'
    )
  }

  if (binding.request.sessionId !== sessionId || binding.request.messageId !== messageId) {
    throw new ExecutionContractDispatchError(
      'Paused tool dispatch does not match its provider View identity.',
      'identity_mismatch'
    )
  }
  if (runtimeContract) {
    if (!executionContractMatchesBinding(runtimeContract, binding)) {
      throw new ExecutionContractDispatchError(
        'Paused tool dispatch does not match its runtime ExecutionContract projection.',
        'invalid_contract'
      )
    }
    return runtimeContract
  }

  let records
  try {
    records = viewManifests
      .listViewManifestsByMessage(sessionId, messageId)
      .filter((record) => record.requestSeq === binding.request.requestSeq)
  } catch (error) {
    throw new ExecutionContractDispatchError(
      'Paused tool dispatch could not recover its ExecutionContract View.',
      'invalid_contract',
      { cause: error }
    )
  }
  if (records.length !== 1) {
    throw new ExecutionContractDispatchError(
      'Paused tool dispatch requires exactly one matching ExecutionContract View.',
      'invalid_contract'
    )
  }

  const manifest = records[0].manifest
  if (manifest.schemaVersion !== 5 || verifyTapeViewManifestHash(manifest) !== 'valid') {
    throw new ExecutionContractDispatchError(
      'Paused tool dispatch ExecutionContract View failed integrity validation.',
      'invalid_contract'
    )
  }
  const recoveredContract = restoreExecutionContract(manifest.executionContract)
  if (!recoveredContract || !executionContractMatchesBinding(recoveredContract, binding)) {
    throw new ExecutionContractDispatchError(
      'Paused tool dispatch ExecutionContract does not match its durable View binding.',
      'invalid_contract'
    )
  }
  return recoveredContract
}
