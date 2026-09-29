// The Storyblok Management API calls the MCP server doesn't expose, published
// on the SBMAPI target. Each is allowed only for this deployment's space.
// SBMAPI's tools take space_id as a top-level argument (unlike SBMCP's nested
// parameters), so Cedar can check it here. A permit condition fails closed:
// if space_id is missing or different, no policy applies and the call is denied.
permit (
    principal,
    action in [
        AgentCore::Action::"SBMAPI___getAiBrandingRules",
        AgentCore::Action::"SBMAPI___aiTranslateStory",
        AgentCore::Action::"SBMAPI___getBackgroundTask"
    ],
    resource == AgentCore::Gateway::"arn:aws:bedrock-agentcore:us-east-1:485530831632:gateway/reinventdemo-reinventdemogateway-ianze4pdtu"
)
when {
    context.input has space_id &&
    context.input.space_id == 575814915634883
};
