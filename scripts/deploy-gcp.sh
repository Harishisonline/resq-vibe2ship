#!/usr/bin/env bash
# Deploy ResQ to Google Cloud Run (project: resq-500822)
# Usage: ./scripts/deploy-gcp.sh
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-resq-500822}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="${GCP_SERVICE:-resq}"
REPO_NAME="${GCP_ARTIFACT_REPO:-resq}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${SERVICE_NAME}:latest"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/.env.local"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "ERROR: gcloud CLI not found."
  echo "Install: https://cloud.google.com/sdk/docs/install"
  echo "Then run: gcloud auth login && gcloud config set project ${PROJECT_ID}"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: Missing ${ENV_FILE} — copy .env.example and fill in values."
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

echo "==> Setting GCP project to ${PROJECT_ID}"
gcloud config set project "$PROJECT_ID"

echo "==> Enabling required APIs"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  --quiet

echo "==> Ensuring Artifact Registry repo exists"
if ! gcloud artifacts repositories describe "$REPO_NAME" --location="$REGION" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPO_NAME" \
    --repository-format=docker \
    --location="$REGION" \
    --description="ResQ container images"
fi

echo "==> Building container via Cloud Build"
gcloud builds submit "$ROOT" \
  --config="$ROOT/cloudbuild.yaml" \
  --substitutions="_IMAGE=${IMAGE},_NEXT_PUBLIC_FIREBASE_API_KEY=${NEXT_PUBLIC_FIREBASE_API_KEY},_NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN},_NEXT_PUBLIC_FIREBASE_PROJECT_ID=${NEXT_PUBLIC_FIREBASE_PROJECT_ID},_NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=${NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET},_NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=${NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID},_NEXT_PUBLIC_FIREBASE_APP_ID=${NEXT_PUBLIC_FIREBASE_APP_ID},_NEXT_PUBLIC_MINIMAX_API_KEY=${NEXT_PUBLIC_MINIMAX_API_KEY:-}" \
  --quiet

# OAuth redirect must point at the deployed URL — updated after first deploy if needed
OAUTH_REDIRECT="${GOOGLE_OAUTH_REDIRECT_URI:-}"

echo "==> Deploying to Cloud Run"
gcloud run deploy "$SERVICE_NAME" \
  --image="$IMAGE" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --memory=1Gi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=10 \
  --concurrency=80 \
  --timeout=120s \
  --set-env-vars="NODE_ENV=production,NEXT_TELEMETRY_DISABLED=1,MINIMAX_BASE_URL=${MINIMAX_BASE_URL:-https://api.minimax.io/v1},MINIMAX_MODEL=${MINIMAX_MODEL:-MiniMax-M2.7},MINIMAX_T2A_URL=${MINIMAX_T2A_URL:-https://api.minimax.io/v1},FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID:-},GOOGLE_OAUTH_CLIENT_ID=${GOOGLE_OAUTH_CLIENT_ID:-},GOOGLE_OAUTH_REDIRECT_URI=${OAUTH_REDIRECT}" \
  --set-secrets="MINIMAX_API_KEY=MINIMAX_API_KEY:latest,GOOGLE_OAUTH_CLIENT_SECRET=GOOGLE_OAUTH_CLIENT_SECRET:latest" \
  --quiet 2>/dev/null || \
gcloud run deploy "$SERVICE_NAME" \
  --image="$IMAGE" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --memory=1Gi \
  --cpu=1 \
  --min-instances=0 \
  --max-instances=10 \
  --concurrency=80 \
  --timeout=120s \
  --set-env-vars="NODE_ENV=production,NEXT_TELEMETRY_DISABLED=1,MINIMAX_API_KEY=${MINIMAX_API_KEY},MINIMAX_BASE_URL=${MINIMAX_BASE_URL:-https://api.minimax.io/v1},MINIMAX_MODEL=${MINIMAX_MODEL:-MiniMax-M2.7},MINIMAX_T2A_URL=${MINIMAX_T2A_URL:-https://api.minimax.io/v1},FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID:-},GOOGLE_OAUTH_CLIENT_ID=${GOOGLE_OAUTH_CLIENT_ID:-},GOOGLE_OAUTH_CLIENT_SECRET=${GOOGLE_OAUTH_CLIENT_SECRET:-},GOOGLE_OAUTH_REDIRECT_URI=${OAUTH_REDIRECT}" \
  --quiet

URL="$(gcloud run services describe "$SERVICE_NAME" --region="$REGION" --format='value(status.url)')"
echo ""
echo "============================================"
echo "  ResQ deployed successfully!"
echo "  URL: ${URL}"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Add ${URL} to Firebase Auth authorized domains"
echo "  2. Update GOOGLE_OAUTH_REDIRECT_URI to ${URL}/api/oauth/google/callback"
echo "  3. Re-run deploy after updating .env.local if OAuth is needed"
