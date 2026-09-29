#!/bin/sh
# Create the SBMAPI Gateway target: the Storyblok Management API calls the
# Storyblok MCP server doesn't expose, published on reInventDemoGateway so Cedar
# authorizes them. Like the SBMCP target, it lives outside the CDK stack.
#
# credentialPrefix is a single space: the Management API wants the raw token
# ("Bearer <token>" gets a 401) and the Gateway requires a non-empty prefix.
# The leading space is optional whitespace in the header value, so the server
# reads the raw token.
# Revert: aws bedrock-agentcore-control delete-gateway-target --region us-east-1 \
#   --gateway-identifier reinventdemo-reinventdemogateway-ianze4pdtu --target-id <id>
cd "$(dirname "$0")" || exit 1
aws bedrock-agentcore-control create-gateway-target \
  --region us-east-1 \
  --cli-input-json file://sbmapi-create-target.json
