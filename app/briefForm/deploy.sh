#!/usr/bin/env bash
# Deploy (or redeploy) the paste-a-brief form.
#
# Standalone on purpose: agentcore/cdk is the agentcore CLI's own scaffolding
# and gets regenerated, so this form stays out of that stack and owns its own
# role, function and URL. Nothing here touches the agent runtime.
#
# Idempotent -- run it again to ship a code change.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
FUNCTION="storyblok-brief-form"
ROLE="storyblok-brief-form-role"
RUNTIME_ARN="${AGENT_RUNTIME_ARN:-arn:aws:bedrock-agentcore:us-east-1:485530831632:runtime/reInventDemo_storyblokAgentGatewayTS-ktiKfjAQaC}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "${BRIEF_FORM_PASSCODE:-}" ]]; then
  echo "Set BRIEF_FORM_PASSCODE to the shared passcode your coworkers will type." >&2
  exit 1
fi

echo "==> Packaging"
cd "$HERE"
npm install --omit=dev --silent
rm -f /tmp/brief-form.zip
zip -qr /tmp/brief-form.zip index.mjs page.html package.json node_modules

echo "==> IAM role"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  echo "    created $ROLE (waiting for propagation)"
  sleep 10
fi

# Scoped to this one runtime -- the form must not be able to invoke anything else.
aws iam put-role-policy --role-name "$ROLE" --policy-name invoke-agent-runtime \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"bedrock-agentcore:InvokeAgentRuntime\"],\"Resource\":[\"$RUNTIME_ARN\",\"$RUNTIME_ARN/*\"]}]}"

ROLE_ARN="$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)"

echo "==> Lambda"
if aws lambda get-function --function-name "$FUNCTION" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FUNCTION" --region "$REGION" \
    --zip-file fileb:///tmp/brief-form.zip >/dev/null
  aws lambda wait function-updated --function-name "$FUNCTION" --region "$REGION"
  aws lambda update-function-configuration --function-name "$FUNCTION" --region "$REGION" \
    --timeout 900 --memory-size 512 \
    --environment "Variables={AGENT_RUNTIME_ARN=$RUNTIME_ARN,BRIEF_FORM_PASSCODE=$BRIEF_FORM_PASSCODE}" >/dev/null
else
  aws lambda create-function --function-name "$FUNCTION" --region "$REGION" \
    --runtime nodejs22.x --handler index.handler --role "$ROLE_ARN" \
    --timeout 900 --memory-size 512 \
    --environment "Variables={AGENT_RUNTIME_ARN=$RUNTIME_ARN,BRIEF_FORM_PASSCODE=$BRIEF_FORM_PASSCODE}" \
    --zip-file fileb:///tmp/brief-form.zip >/dev/null
fi
aws lambda wait function-updated --function-name "$FUNCTION" --region "$REGION"

echo "==> Function URL"
# RESPONSE_STREAM is what lets a 10-minute run report progress instead of
# buffering until the end (and blowing the 6 MB buffered-response limit).
if ! aws lambda get-function-url-config --function-name "$FUNCTION" --region "$REGION" >/dev/null 2>&1; then
  aws lambda create-function-url-config --function-name "$FUNCTION" --region "$REGION" \
    --auth-type NONE --invoke-mode RESPONSE_STREAM >/dev/null
  aws lambda add-permission --function-name "$FUNCTION" --region "$REGION" \
    --statement-id public-url --action lambda:InvokeFunctionUrl \
    --principal '*' --function-url-auth-type NONE >/dev/null
else
  aws lambda update-function-url-config --function-name "$FUNCTION" --region "$REGION" \
    --auth-type NONE --invoke-mode RESPONSE_STREAM >/dev/null
fi

URL="$(aws lambda get-function-url-config --function-name "$FUNCTION" --region "$REGION" --query FunctionUrl --output text)"
echo
echo "Ready. Send your coworkers:"
echo "    $URL"
echo "and the passcode, separately."
