locals {
  # Kratos' self-service endpoints that AUTH-08 protects. `starts_with` also covers the /browser and /api sub-paths.
  auth_paths = join(" or ", [
    "starts_with(http.request.uri.path, \"/self-service/login\")",
    "starts_with(http.request.uri.path, \"/self-service/recovery\")",
  ])

  auth_attempts = "(http.host eq \"${var.hostnames.auth}\" and http.request.method eq \"POST\" and (${local.auth_paths}))"

  # Kratos answers a failed attempt with one of these; a browser form post that fails is a 303 back to the flow, so
  # 303 can't be told apart from success here and is not counted.
  failed_attempts = "${local.auth_attempts} and http.response.code in {400 401 403 422 429}"
}

resource "cloudflare_record" "service" {
  for_each = var.hostnames

  zone_id = var.cloudflare_zone_id
  name    = each.value
  type    = "CNAME"
  content = var.origin_hostname
  proxied = true
  ttl     = 1
  comment = "Montra ${each.key}, managed by Terraform"
}

resource "cloudflare_zone_settings_override" "this" {
  zone_id = var.cloudflare_zone_id

  settings {
    ssl              = "strict" # Cloudflare checks the ALB's ACM certificate.
    min_tls_version  = "1.2"    # NFR-01
    tls_1_3          = "on"
    always_use_https = "on"
    security_level   = "medium"

    security_header {
      enabled            = true
      include_subdomains = true
      preload            = false
      max_age            = 31536000
      nosniff            = true
    }
  }
}

resource "cloudflare_ruleset" "managed_waf" {
  count = var.managed_waf_enabled ? 1 : 0

  zone_id     = var.cloudflare_zone_id
  name        = "Montra managed WAF"
  description = "Cloudflare Managed and OWASP core rulesets"
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules {
    description = "Cloudflare Managed Ruleset"
    expression  = "true"
    action      = "execute"
    enabled     = true

    action_parameters {
      id = "efb7b8c949ac4650a09736fc376e9aee"
    }
  }

  rules {
    description = "Cloudflare OWASP Core Ruleset"
    expression  = "true"
    action      = "execute"
    enabled     = true

    action_parameters {
      id = "4814384a9e5d4991b9815dcfc25d2f1f"
    }
  }
}

resource "cloudflare_ruleset" "custom_firewall" {
  zone_id     = var.cloudflare_zone_id
  name        = "Montra firewall"
  description = "Paths that must not be reachable from the internet"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  # The ALB also answers 404 here. /internal/kratos/hooks stays open because Kratos reaches it through this edge; it
  # is authenticated with a shared secret.
  rules {
    description = "Block the metrics endpoint"
    expression  = "(http.host eq \"${var.hostnames.api}\" and starts_with(http.request.uri.path, \"/internal/metrics\"))"
    action      = "block"
    enabled     = true
  }
}

resource "cloudflare_ruleset" "rate_limit" {
  zone_id     = var.cloudflare_zone_id
  name        = "Montra rate limits"
  description = "Brute-force protection for sign-in and recovery (AUTH-08)"
  kind        = "zone"
  phase       = "http_ratelimit"

  # Rules run in order and the first match with an exceeded limit wins, so the hard limit comes first.
  rules {
    description = "Block sustained attempts on login and recovery"
    expression  = local.auth_attempts
    action      = "block"
    enabled     = true

    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = var.rate_limit_period_seconds
      requests_per_period = var.block_requests_per_period
      mitigation_timeout  = var.block_timeout_seconds
    }
  }

  rules {
    description = "Managed challenge after repeated attempts on login and recovery"
    expression  = local.auth_attempts
    action      = "managed_challenge"
    enabled     = true

    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = var.rate_limit_period_seconds
      requests_per_period = var.challenge_requests_per_period
      mitigation_timeout  = 0 # Challenge actions don't take a timeout.
      counting_expression = var.count_failures_only ? local.failed_attempts : null
    }
  }
}
