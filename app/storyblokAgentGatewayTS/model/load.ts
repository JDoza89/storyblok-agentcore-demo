import { BedrockModel } from '@strands-agents/sdk/models/bedrock';

/** Get a native Bedrock Claude model client using the execution role's IAM credentials. */
export function loadModel(): BedrockModel {
  return new BedrockModel({
    modelId: 'us.anthropic.claude-sonnet-5-5',
    region: 'us-east-1',
    // The page-writing turn emits the whole story as one tool call (14k+ output tokens on
    // Sonnet 4.5, more with the 5.x tokenizer). Bedrock's per-model default is too low for it.
    maxTokens: 32_000,
  });
}
