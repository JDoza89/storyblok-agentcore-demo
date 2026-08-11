// Exactly the Storyblok operations this agent is currently allowed to run.
//
// To allow a new operation: add its exact name to the matching list
// below (readonly or mutating) and redeploy -- nothing else in this
// file needs to change.
// To remove one: delete its line.
//
// This is intentionally the ONLY thing gating execute_readonly /
// execute_mutating -- there is no other policy narrowing these two
// actions, so an operation not listed here is denied by default.
permit (
    principal,
    action in [
        AgentCore::Action::"SBMCP___execute_readonly",
        AgentCore::Action::"SBMCP___execute_mutating"
    ],
    resource == AgentCore::Gateway::"arn:aws:bedrock-agentcore:us-east-1:485530831632:gateway/reinventdemo-reinventdemogateway-ianze4pdtu"
)
when {
    [
        // -- readonly, via SBMCP___execute_readonly --
        "getStoryById",
        "listStories",
        "listAssetFolders",
        "getComponent",
        "listAssets",

        // -- mutating, via SBMCP___execute_mutating --
        "createStory",
        "updateAsset",
        "createWorkflowStageChange"
    ].contains(context.input.operation)
};
