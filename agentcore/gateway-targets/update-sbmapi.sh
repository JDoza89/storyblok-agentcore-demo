#!/bin/sh
# Push storyblok-mapi.openapi.json to the existing SBMAPI target (SPMSXICSJX).
# Regenerate sbmapi-update-target.json from the spec first if you edit it.
cd "$(dirname "$0")" || exit 1
aws bedrock-agentcore-control update-gateway-target \
  --region us-east-1 \
  --cli-input-json file://sbmapi-update-target.json
