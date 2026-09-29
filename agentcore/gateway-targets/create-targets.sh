#!/bin/sh
# Create the SBMCP and SBMAPI Gateway targets for a deploy target, after its
# first `agentcore deploy --target <name>`. Both targets live outside the CDK
# stack, so a fresh account needs them created once.
#
# Reads the new Gateway id and the storyblok-mcp-pat credential provider ARN
# from agentcore/.cli/deployed-state.json (written by that deploy), so nothing
# account-specific is hard-coded here.
#
#   sh agentcore/gateway-targets/create-targets.sh neworg
#
# Refuses to run for the original "default" target, which already has both.
set -eu
TARGET="${1:?usage: create-targets.sh <deploy-target-name>}"
[ "$TARGET" = "default" ] && { echo "Refusing: the default target already has its Gateway targets." >&2; exit 1; }

cd "$(dirname "$0")/../.."
OUT="$(mktemp -d)"
python3 - "$TARGET" "$OUT" <<'EOF'
import json, sys
target, out = sys.argv[1], sys.argv[2]
targets = json.load(open('agentcore/aws-targets.json'))
region = next(t['region'] for t in targets if t['name'] == target)
res = json.load(open('agentcore/.cli/deployed-state.json'))['targets'][target]['resources']
gateway_id = res['gateways']['reInventDemoGateway']['gatewayId']
provider = res['credentials']['storyblok-mcp-pat']['credentialProviderArn']

def auth(prefix):
    return [{"credentialProviderType": "API_KEY", "credentialProvider": {"apiKeyCredentialProvider": {
        "providerArn": provider, "credentialParameterName": "Authorization",
        "credentialPrefix": prefix, "credentialLocation": "HEADER"}}}]

# SBMCP: Storyblok's MCP server, which expects "Bearer <PAT>".
json.dump({"gatewayIdentifier": gateway_id, "name": "SBMCP",
           "targetConfiguration": {"mcp": {"mcpServer": {"endpoint": "https://mcp.storyblok.com/mcp"}}},
           "credentialProviderConfigurations": auth("Bearer ")}, open(f"{out}/sbmcp.json", "w"))
# SBMAPI: the Management API calls MCP doesn't expose. The API wants the raw
# token, and the Gateway requires a non-empty prefix, so the prefix is one space.
json.dump({"gatewayIdentifier": gateway_id, "name": "SBMAPI",
           "description": "Storyblok Management API calls the Storyblok MCP server doesn't expose (AI branding, AI translate)",
           "targetConfiguration": {"mcp": {"openApiSchema": {
               "inlinePayload": open('agentcore/gateway-targets/storyblok-mapi.openapi.json').read()}}},
           "credentialProviderConfigurations": auth(" ")}, open(f"{out}/sbmapi.json", "w"))
open(f"{out}/region", "w").write(region)
print(f"Gateway {gateway_id} in {region}")
EOF
REGION="$(cat "$OUT/region")"
for t in sbmcp sbmapi; do
  aws bedrock-agentcore-control create-gateway-target --region "$REGION" \
    --cli-input-json "file://$OUT/$t.json" --query '[name,targetId,status]' --output text
done
rm -rf "$OUT"
