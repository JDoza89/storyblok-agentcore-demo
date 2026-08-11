// Metadata-only lookups against Storyblok's cached OpenAPI catalog.
// These never touch real space data, so they're unconditional --
// no operation-level restriction needed.
permit (
    principal,
    action in [
        AgentCore::Action::"SBMCP___search",
        AgentCore::Action::"SBMCP___describe"
    ],
    resource == AgentCore::Gateway::"arn:aws:bedrock-agentcore:us-east-1:485530831632:gateway/reinventdemo-reinventdemogateway-ianze4pdtu"
);
