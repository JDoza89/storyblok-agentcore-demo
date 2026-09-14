import { BedrockModel } from '@strands-agents/sdk/models/bedrock';

/** Get a native Bedrock Claude model client using the execution role's IAM credentials. */
export function loadModel(): BedrockModel {
  return new BedrockModel({
    modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    region: 'us-east-1',
  });
}
