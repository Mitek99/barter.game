#!/usr/bin/env bash
# Deploy the AWS banks: build the Lambda bundle, sam deploy, then sync the
# static web client into the assets bucket and invalidate CloudFront.
#
# Usage: AWS_PROFILE=<profile> ./deploy.sh
#
# Prereqs:
#   - AWS credentials for the target account (AWS_PROFILE or env)
#   - bank keys in SSM, one SecureString per bank:
#       aws ssm put-parameter --type SecureString --name /barter/banks/alice \
#         --value "$(bun run ../../scripts/genkey.ts | grep PRIV | cut -d= -f2)"
#   - stack/region settings live in samconfig.toml
set -euo pipefail
cd "$(dirname "$0")"

STACK="${STACK_NAME:-barter-banks}"

echo "==> build"
bun run build

echo "==> sam deploy ($STACK)"
sam deploy --stack-name "$STACK" "$@"

# sam reads its region from samconfig.toml, the plain AWS CLI does not — so
# resolve one region explicitly and use it for every call below, or the
# post-deploy steps can silently address a different region's (nonexistent)
# stack.
REGION="${AWS_REGION:-$(sed -n 's/^[[:space:]]*region[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' samconfig.toml 2>/dev/null | head -1)}"
REGION="${REGION:-$(aws configure get region)}"
if [ -z "$REGION" ]; then
  echo "cannot resolve an AWS region (set AWS_REGION)" >&2
  exit 1
fi
echo "==> region: $REGION"

echo "==> resolve outputs"
outputs=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query 'Stacks[0].Outputs' --output json)
bucket=$(echo "$outputs" | jq -r '.[] | select(.OutputKey=="AssetsBucketName").OutputValue')
dist_id=$(echo "$outputs" | jq -r '.[] | select(.OutputKey=="DistributionId").OutputValue')
domain=$(echo "$outputs" | jq -r '.[] | select(.OutputKey=="DistributionDomain").OutputValue')

echo "==> sync web client to s3://$bucket/webapp/"
aws s3 sync ../web "s3://$bucket/webapp/" --region "$REGION" \
  --exclude 'package.json' --exclude 'README.md' --exclude 'node_modules/*' \
  --cache-control 'public, max-age=300' --delete

# Invalidate the CACHE-KEY path, not the viewer path: StaticRewriteFunction
# runs at viewer-request, so these objects are cached under /webapp/*. (An
# invalidation wildcard is also only a wildcard at the end of the path — a
# '*' in the middle matches a literal asterisk.)
echo "==> invalidate CloudFront ($dist_id)"
aws cloudfront create-invalidation --distribution-id "$dist_id" \
  --paths '/webapp/*' >/dev/null

echo "==> done: https://$domain/"
echo "    website:      https://$domain/"
echo "    bank UI:      https://$domain/<bank>/ui"
