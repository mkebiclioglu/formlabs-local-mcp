#!/usr/bin/env bash
# Vercel install step. See deploy/README.md.
set -euo pipefail
REF="${FORMBRIDGE_GIT_REF:-cloud}"
rm -rf /tmp/formbridge-src
git clone --depth 1 --branch "$REF" https://github.com/mkebiclioglu/formlabs-local-mcp.git /tmp/formbridge-src
cp -R /tmp/formbridge-src/cloud/. .
cat > lib/runtime-env.generated.ts <<TS
export const GENERATED_ENV: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://<ref>.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_...",
  FORMBRIDGE_SERVICE_EMAIL: "service@example.com",
  FORMBRIDGE_SERVICE_PASSWORD: "...",
  NEXT_PUBLIC_APP_URL: "https://formbridge-mcp-kutay-dev.vercel.app",
};
TS
echo "formbridge: checked out $(git -C /tmp/formbridge-src rev-parse --short HEAD) ($REF)"
npm ci
