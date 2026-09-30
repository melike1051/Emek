#!/usr/bin/env bash
# Web + operasyon paneli dağıtımı (R-105). deploy.yml staging ve production işleri çağırır.
#
#   deploy-frontends.sh <environment> <project_id> <region> <git_sha>
#
# İmaj **ortama özel** derlenir: `NEXT_PUBLIC_*` (Firebase web yapılandırması, gizli değil)
# derleme anında pakete gömülür. Bu yüzden API'deki "staging'de doğrulanan aynı digest"
# modeli ön uçlar için yoktur; her ortam aynı commit'ten kendi imajını derler.
#
# API ile aynı güvenli sıra: aday revizyon **trafiksiz** oluşur, smoke geçerse trafik taşınır.
set -euo pipefail

environment="$1"
project="$2"
region="$3"
sha="$4"
registry="${region}-docker.pkg.dev/${project}/emek"

for name in NEXT_PUBLIC_FIREBASE_API_KEY NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
  NEXT_PUBLIC_FIREBASE_PROJECT_ID NEXT_PUBLIC_FIREBASE_APP_ID NEXT_PUBLIC_APP_CHECK_SITE_KEY; do
  if [ -z "${!name:-}" ]; then
    echo "$name tanımlı değil (${environment} GitHub vars). Ön uç derlenmedi." >&2
    exit 1
  fi
done

for app in web admin; do
  image="${registry}/${app}:${sha}"
  docker build -f infra/docker/Dockerfile.frontend \
    --build-arg APP="$app" --build-arg GIT_SHA="$sha" \
    --build-arg NEXT_PUBLIC_AUTH_MODE=firebase \
    --build-arg NEXT_PUBLIC_FIREBASE_API_KEY \
    --build-arg NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN \
    --build-arg NEXT_PUBLIC_FIREBASE_PROJECT_ID \
    --build-arg NEXT_PUBLIC_FIREBASE_APP_ID \
    --build-arg NEXT_PUBLIC_APP_CHECK_SITE_KEY \
    -t "$image" .
  docker push "$image"
  digest=$(docker inspect --format='{{range .RepoDigests}}{{println .}}{{end}}' "$image" |
    grep "^${registry}/${app}@")

  service="emek-${environment}-${app}"
  gcloud run deploy "$service" --project "$project" --region "$region" \
    --image "$digest" --no-traffic --tag candidate --quiet
  candidate=$(gcloud run services describe "$service" --project "$project" --region "$region" \
    --format='value(status.traffic.filter("tag:candidate").extract("url").flatten())')
  if [ -z "$candidate" ]; then
    echo "${service}: aday revizyon adresi okunamadı" >&2
    exit 1
  fi

  if [ "$app" = web ]; then
    # Sayfa açılır ve istek başına nonce'lu CSP taşır; satır içi script izni yoktur.
    headers=$(curl -fsS -D - -o /dev/null "${candidate}/giris")
    csp=$(printf '%s' "$headers" | grep -i '^content-security-policy:' || true)
    if ! printf '%s' "$csp" | grep -q "'nonce-" || printf '%s' "$csp" | grep -q "script-src[^;]*'unsafe-inline'"; then
      echo "web smoke: nonce'lu CSP yok" >&2
      exit 1
    fi
  else
    # Panel IAP arkasında: kimliksiz istek Google girişine yönlenmeli ya da IAP tarafından
    # reddedilmeli. "200 değil" yetmez — çöken bir revizyonun 500'ü IAP kanıtı sayılırdı.
    response=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "${candidate}/giris")
    status=${response%% *}
    location=${response#* }
    case "$status" in
      302)
        case "$location" in
          https://accounts.google.com/* | */_gcp_iap/*) ;;
          *)
            echo "admin smoke: IAP dışı yönlendirme ($location)" >&2
            exit 1
            ;;
        esac
        ;;
      401 | 403) ;;
      *)
        echo "admin smoke: IAP imzası yok (HTTP $status)" >&2
        exit 1
        ;;
    esac
    # IAP kapısı sayfanın çalıştığını göstermez: revizyonun hazır olduğu ayrıca doğrulanır.
    ready=$(gcloud run services describe "$service" --project "$project" --region "$region" \
      --format='value(status.conditions.filter("type:Ready").extract("status").flatten())')
    if [ "$ready" != True ]; then
      echo "admin smoke: servis hazır değil ($ready)" >&2
      exit 1
    fi
  fi

  gcloud run services update-traffic "$service" --project "$project" --region "$region" \
    --to-latest --quiet
  echo "${service}: ${digest}"
done
