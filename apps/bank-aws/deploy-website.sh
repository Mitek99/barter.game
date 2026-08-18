#!/usr/bin/env bash
# Deploy the public website (Hugo, website/) to the bank stack's assets bucket
# and invalidate CloudFront. This is the whole "hosting provider" now: build
# locally, sync to s3://<assets>/site/, done — no Netlify.
#
# Usage: AWS_PROFILE=<profile> ./deploy-website.sh
#
# Prereqs: hugo (+ go, for theme modules); the barter-banks stack deployed.
set -euo pipefail
cd "$(dirname "$0")"

STACK="${STACK_NAME:-barter-banks}"
REGION="${AWS_REGION:-$(sed -n 's/^[[:space:]]*region[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' samconfig.toml 2>/dev/null | head -1)}"
REGION="${REGION:-$(aws configure get region)}"
if [ -z "$REGION" ]; then
  echo "cannot resolve an AWS region (set AWS_REGION)" >&2
  exit 1
fi

echo "==> build hugo site"
# HUGO_ENV=production mirrors what netlify.toml set: it gates the PostHog
# analytics partial (website/layouts/_partials/custom/head-end.html).
(cd ../../website && hugo mod get && HUGO_ENV=production hugo --gc --minify)

echo "==> resolve outputs ($STACK @ $REGION)"
outputs=$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query 'Stacks[0].Outputs' --output json)
bucket=$(echo "$outputs" | jq -r '.[] | select(.OutputKey=="AssetsBucketName").OutputValue')
dist_id=$(echo "$outputs" | jq -r '.[] | select(.OutputKey=="DistributionId").OutputValue')
domain=$(echo "$outputs" | jq -r '.[] | select(.OutputKey=="DistributionDomain").OutputValue')

echo "==> sync site to s3://$bucket/site/"
aws s3 sync ../../website/public/ "s3://$bucket/site/" --region "$REGION" \
  --cache-control 'public, max-age=300' --delete

# Invalidate the CACHE-KEY paths: SiteRewriteFunction prefixes /site at
# viewer-request, so pages are cached under /site/*.
echo "==> invalidate CloudFront ($dist_id)"
aws cloudfront create-invalidation --distribution-id "$dist_id" \
  --paths '/site/*' >/dev/null

echo "==> done: https://$domain/"
