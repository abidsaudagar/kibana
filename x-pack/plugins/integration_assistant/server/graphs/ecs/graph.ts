/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  ActionsClientChatOpenAI,
  ActionsClientSimpleChatModel,
} from '@kbn/langchain/server/language_models';
import { END, START, StateGraph, Send } from '@langchain/langgraph';
import type { EcsMappingState } from '../../types';
import { modelInput, modelOutput, modelSubOutput } from './model';
import { handleDuplicates } from './duplicates';
import { handleInvalidEcs } from './invalid';
import { handleEcsMapping } from './mapping';
import { handleMissingKeys } from './missing';
import { handleValidateMappings } from './validate';
import { graphState } from './state';

const handleCreateMappingChunks = async (state: EcsMappingState) => {
  // Cherrypick a shallow copy of state to pass to subgraph
  const stateParams = {
    exAnswer: state.exAnswer,
    prefixedSamples: state.prefixedSamples,
    ecs: state.ecs,
    dataStreamName: state.dataStreamName,
    packageName: state.packageName,
  };
  if (Object.keys(state.currentMapping).length === 0) {
    return state.sampleChunks.map((chunk) => {
      return new Send('subGraph', { ...stateParams, combinedSamples: chunk });
    });
  }
  return 'modelOutput';
};

function chainRouter(state: EcsMappingState): string {
  if (Object.keys(state.duplicateFields).length > 0) {
    return 'duplicateFields';
  }
  if (Object.keys(state.missingKeys).length > 0) {
    return 'missingKeys';
  }
  if (Object.keys(state.invalidEcsFields).length > 0) {
    return 'invalidEcsFields';
  }
  if (!state.finalized) {
    return 'modelSubOutput';
  }
  return END;
}

// This is added as a separate graph to be able to run these steps concurrently from handleCreateMappingChunks
async function getEcsSubGraph(model: ActionsClientChatOpenAI | ActionsClientSimpleChatModel) {
  const workflow = new StateGraph({
    channels: graphState,
  })
    .addNode('modelSubOutput', modelSubOutput)
    .addNode('handleValidation', handleValidateMappings)
    .addNode('handleEcsMapping', (state: EcsMappingState) => handleEcsMapping(state, model))
    .addNode('handleDuplicates', (state: EcsMappingState) => handleDuplicates(state, model))
    .addNode('handleMissingKeys', (state: EcsMappingState) => handleMissingKeys(state, model))
    .addNode('handleInvalidEcs', (state: EcsMappingState) => handleInvalidEcs(state, model))
    .addEdge(START, 'handleEcsMapping')
    .addEdge('handleEcsMapping', 'handleValidation')
    .addEdge('handleDuplicates', 'handleValidation')
    .addEdge('handleMissingKeys', 'handleValidation')
    .addEdge('handleInvalidEcs', 'handleValidation')
    .addConditionalEdges('handleValidation', chainRouter, {
      duplicateFields: 'handleDuplicates',
      missingKeys: 'handleMissingKeys',
      invalidEcsFields: 'handleInvalidEcs',
      modelSubOutput: 'modelSubOutput',
    })
    .addEdge('modelSubOutput', END);

  const compiledEcsSubGraph = workflow.compile();

  return compiledEcsSubGraph;
}

export async function getEcsGraph(model: ActionsClientChatOpenAI | ActionsClientSimpleChatModel) {
  const subGraph = await getEcsSubGraph(model);
  const workflow = new StateGraph({
    channels: graphState,
  })
    .addNode('modelInput', modelInput)
    .addNode('modelOutput', modelOutput)
    .addNode('subGraph', subGraph)
    .addEdge(START, 'modelInput')
    .addEdge('subGraph', 'modelOutput')
    .addConditionalEdges('modelInput', handleCreateMappingChunks)
    .addEdge('modelOutput', END);

  const compiledEcsGraph = workflow.compile();

  return compiledEcsGraph;
}
