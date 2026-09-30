#!/bin/sh
# Create a deploy target's skills bucket and upload every skill in skills/.
# The bucket is named storyblok-agentcore-skills-<account>, which is what the
# CDK stack grants the runtime and passes to it as SKILLS_S3_URI.
#
#   sh agentcore/setup-skills-bucket.sh default
#
# Uploads without --delete, so nothing already in the bucket is removed.
# Refuses to run for the original account (485530831632), whose bucket already exists.
set -eu
TARGET="${1:?usage: setup-skills-bucket.sh <deploy-target-name>}"

cd "$(dirname "$0")/.."
read -r ACCOUNT REGION <<EOF
$(python3 -c "import json,sys; t=next(t for t in json.load(open('agentcore/aws-targets.json')) if t['name']==sys.argv[1]); print(t['account'], t['region'])" "$TARGET")
EOF
[ "$ACCOUNT" = "485530831632" ] && { echo "Refusing: $TARGET is the original account, whose bucket already exists." >&2; exit 1; }
BUCKET="storyblok-agentcore-skills-$ACCOUNT"

ACTIVE="$(aws sts get-caller-identity --query Account --output text)"
[ "$ACTIVE" = "$ACCOUNT" ] || { echo "Active credentials are for $ACTIVE, not $ACCOUNT. Set AWS_PROFILE first." >&2; exit 1; }

if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "Bucket $BUCKET exists"
else
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  echo "Created $BUCKET"
fi
aws s3 sync skills/ "s3://$BUCKET/" --exclude ".DS_Store" --only-show-errors
aws s3 ls "s3://$BUCKET/"
