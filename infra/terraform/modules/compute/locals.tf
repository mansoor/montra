data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  region = data.aws_region.current.name

  web_url  = "https://${var.hostnames.web}"
  api_url  = "https://${var.hostnames.api}"
  auth_url = "https://${var.hostnames.auth}"

  service_discovery_namespace = "${var.name}.internal"
  kratos_public_url           = "http://kratos.${local.service_discovery_namespace}:4433"
  kratos_admin_url            = "http://kratos.${local.service_discovery_namespace}:4434"

  # Secrets hold their values in Secrets Manager only. Terraform creates the empty containers and the owner fills them
  # in (docs/runbooks/first-time-setup.md), so no value reaches the state file.
  secret_names = toset([
    "ADMIN_DATABASE_URL",
    "ANTHROPIC_API_KEY",
    "DATABASE_ADMIN_URL",
    "DATABASE_URL",
    "KRATOS_CIPHER_SECRET",
    "KRATOS_COOKIE_SECRET",
    "KRATOS_DSN",
    "KRATOS_SMTP_URL",
    "KRATOS_WEBHOOK_SECRET",
    "MAIL_URL",
    "METRICS_TOKEN",
    "SENTRY_DSN",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "SUPPORT_DATABASE_URL",
  ])

  api_environment = merge({
    NODE_ENV                 = "production"
    PORT                     = "4000"
    AUTH_MODE                = "kratos"
    KRATOS_PUBLIC_URL        = local.kratos_public_url
    KRATOS_ADMIN_URL         = local.kratos_admin_url
    KMS_MODE                 = "aws"
    AWS_KMS_KEY_ID           = var.data_key_arn
    STORAGE_MODE             = "s3"
    S3_BUCKET                = var.s3_bucket_name
    S3_REGION                = local.region
    MAIL_MODE                = "smtp"
    MAIL_FROM                = var.mail_from
    BILLING_MODE             = var.billing_mode
    STRIPE_PRICE_PRO_MONTHLY = var.stripe_price_pro_monthly
    STRIPE_PRICE_PRO_YEARLY  = var.stripe_price_pro_yearly
    API_URL                  = local.api_url
    WEB_URL                  = local.web_url
    SUPPORT_EMAIL            = var.support_email
    PUSH_MODE                = "expo"
    # The hosted service can't reach a user's own AI endpoint (see apps/api/src/config.ts).
    AI_LOCAL_DIRECT = "false"
    # Cloudflare, then the load balancer: without this, the API sees the load balancer as every client.
    TRUST_PROXY_HOPS = "2"
  }, var.extra_environment)

  api_secrets = [
    "ADMIN_DATABASE_URL",
    "ANTHROPIC_API_KEY",
    "DATABASE_URL",
    "KRATOS_WEBHOOK_SECRET",
    "MAIL_URL",
    "METRICS_TOKEN",
    "SENTRY_DSN",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "SUPPORT_DATABASE_URL",
  ]

  # kratos.yml holds local values. Everything environment-specific is overridden here.
  # A list value is JSON, which is how Kratos reads list-typed settings from the environment.
  kratos_environment = {
    SERVE_PUBLIC_BASE_URL                                           = "${local.auth_url}/"
    SERVE_PUBLIC_CORS_ALLOWED_ORIGINS                               = jsonencode([local.web_url])
    SERVE_ADMIN_BASE_URL                                            = "${local.kratos_admin_url}/"
    SELFSERVICE_DEFAULT_BROWSER_RETURN_URL                          = "${local.web_url}/"
    SELFSERVICE_ALLOWED_RETURN_URLS                                 = jsonencode([local.web_url])
    SELFSERVICE_FLOWS_ERROR_UI_URL                                  = "${local.web_url}/auth/error"
    SELFSERVICE_FLOWS_SETTINGS_UI_URL                               = "${local.web_url}/settings/security"
    SELFSERVICE_FLOWS_RECOVERY_UI_URL                               = "${local.web_url}/auth/recovery"
    SELFSERVICE_FLOWS_VERIFICATION_UI_URL                           = "${local.web_url}/auth/verification"
    SELFSERVICE_FLOWS_VERIFICATION_AFTER_DEFAULT_BROWSER_RETURN_URL = "${local.web_url}/welcome"
    SELFSERVICE_FLOWS_LOGIN_UI_URL                                  = "${local.web_url}/sign-in"
    SELFSERVICE_FLOWS_REGISTRATION_UI_URL                           = "${local.web_url}/sign-up"
    SELFSERVICE_METHODS_PASSKEY_CONFIG_RP_ID                        = var.cookie_domain
    SELFSERVICE_METHODS_PASSKEY_CONFIG_RP_ORIGINS                   = jsonencode([local.web_url])
    SELFSERVICE_METHODS_WEBAUTHN_CONFIG_RP_ID                       = var.cookie_domain
    SELFSERVICE_METHODS_WEBAUTHN_CONFIG_RP_ORIGINS                  = jsonencode([local.web_url])
    # Setting any item of a list by index replaces the whole list from kratos.yml, so every field is repeated here.
    SELFSERVICE_FLOWS_RECOVERY_AFTER_HOOKS_0_HOOK                    = "revoke_active_sessions"
    SELFSERVICE_FLOWS_RECOVERY_AFTER_HOOKS_1_HOOK                    = "web_hook"
    SELFSERVICE_FLOWS_RECOVERY_AFTER_HOOKS_1_CONFIG_URL              = "${local.api_url}/internal/kratos/hooks"
    SELFSERVICE_FLOWS_RECOVERY_AFTER_HOOKS_1_CONFIG_METHOD           = "POST"
    SELFSERVICE_FLOWS_RECOVERY_AFTER_HOOKS_1_CONFIG_BODY             = "base64://ZnVuY3Rpb24oY3R4KSB7IGV2ZW50OiAncmVjb3ZlcnknLCBpZGVudGl0eV9pZDogY3R4LmlkZW50aXR5LmlkIH0="
    SELFSERVICE_FLOWS_RECOVERY_AFTER_HOOKS_1_CONFIG_AUTH_TYPE        = "api_key"
    SELFSERVICE_FLOWS_RECOVERY_AFTER_HOOKS_1_CONFIG_AUTH_CONFIG_NAME = "x-montra-hook-secret"
    SELFSERVICE_FLOWS_RECOVERY_AFTER_HOOKS_1_CONFIG_AUTH_CONFIG_IN   = "header"
    SESSION_COOKIE_DOMAIN                                            = var.cookie_domain
    COOKIES_DOMAIN                                                   = var.cookie_domain
    COURIER_SMTP_FROM_ADDRESS                                        = var.kratos_from_address
  }

  kratos_secret_environment = {
    DSN                                                               = "KRATOS_DSN"
    SECRETS_COOKIE                                                    = "KRATOS_COOKIE_SECRET"
    SECRETS_CIPHER                                                    = "KRATOS_CIPHER_SECRET"
    COURIER_SMTP_CONNECTION_URI                                       = "KRATOS_SMTP_URL"
    SELFSERVICE_FLOWS_RECOVERY_AFTER_HOOKS_1_CONFIG_AUTH_CONFIG_VALUE = "KRATOS_WEBHOOK_SECRET"
  }

  # One entry per long-running service. `secrets` maps an environment variable to the secret holding its value.
  services = {
    api = {
      repository   = "api"
      command      = null
      port         = 4000
      cpu          = var.services.api.cpu
      memory       = var.services.api.memory
      desired      = var.services.api.min
      environment  = local.api_environment
      secrets      = { for name in local.api_secrets : name => name }
      collector    = true
      stop_timeout = 60
    }
    worker = {
      repository   = "api"
      command      = ["node", "dist/worker-main.js"]
      port         = null
      cpu          = var.services.worker.cpu
      memory       = var.services.worker.memory
      desired      = var.services.worker.min
      environment  = local.api_environment
      secrets      = { for name in local.api_secrets : name => name }
      collector    = false
      stop_timeout = 120 # Lets a running job finish on SIGTERM.
    }
    doc-worker = {
      repository   = "doc-worker"
      command      = null
      port         = null
      cpu          = var.services.doc_worker.cpu
      memory       = var.services.doc_worker.memory
      desired      = var.services.doc_worker.desired
      environment  = { STORAGE_MODE = "s3", S3_BUCKET = var.s3_bucket_name, S3_REGION = local.region }
      secrets      = { DATABASE_URL = "DATABASE_URL" }
      collector    = false
      stop_timeout = 120
    }
    web = {
      repository   = "web"
      command      = null
      port         = 3000
      cpu          = var.services.web.cpu
      memory       = var.services.web.memory
      desired      = var.services.web.min
      environment  = { NODE_ENV = "production", API_URL = local.api_url, KRATOS_PUBLIC_URL = local.kratos_public_url }
      secrets      = {}
      collector    = false
      stop_timeout = 30
    }
    kratos = {
      repository   = "kratos"
      command      = ["serve", "-c", "/etc/config/kratos/kratos.yml"]
      port         = 4433
      cpu          = var.services.kratos.cpu
      memory       = var.services.kratos.memory
      desired      = var.services.kratos.desired
      environment  = local.kratos_environment
      secrets      = local.kratos_secret_environment
      collector    = false
      stop_timeout = 30
    }
    # The courier sends recovery and verification email. Kratos needs it to run as a single instance, so it is not
    # part of the scalable kratos service.
    kratos-courier = {
      repository   = "kratos"
      command      = ["courier", "watch", "-c", "/etc/config/kratos/kratos.yml"]
      port         = null
      cpu          = var.services.kratos_courier.cpu
      memory       = var.services.kratos_courier.memory
      desired      = 1
      environment  = local.kratos_environment
      secrets      = local.kratos_secret_environment
      collector    = false
      stop_timeout = 30
    }
  }

  # CodeDeploy blue/green needs a load balancer, so only services that take traffic through the ALB can use it, and
  # it rules out Cloud Map on those services. Kratos stays rolling because the API reaches it through Cloud Map.
  blue_green_services = { api = var.hostnames.api, web = var.hostnames.web }
  health_check_paths  = { api = "/readyz", web = "/", kratos = "/health/ready" }

  rolling_services = {
    for name, service in local.services : name => service if !contains(keys(local.blue_green_services), name)
  }

  # One-off tasks, run by deploy.yml before traffic moves.
  one_off_tasks = {
    migrate = {
      repository  = "api"
      command     = ["node", "node_modules/@montra/db/dist/cli.js", "migrate"]
      environment = { NODE_ENV = "production" }
      secrets     = { DATABASE_ADMIN_URL = "DATABASE_ADMIN_URL" }
      cpu         = 512
      memory      = 1024
    }
    kratos-migrate = {
      repository  = "kratos"
      command     = ["migrate", "sql", "-e", "--yes", "-c", "/etc/config/kratos/kratos.yml"]
      environment = {}
      secrets     = { DSN = "KRATOS_DSN" }
      cpu         = 256
      memory      = 512
    }
  }

  repositories = toset(["api", "doc-worker", "kratos", "web"])

  # Runs in the API task and turns the Prometheus endpoint into CloudWatch metrics, for worker autoscaling and alarms.
  # Only low-cardinality metrics go to CloudWatch. Everything else stays in Prometheus (infra/observability).
  collector_config = <<-EOT
    extensions:
      health_check:
    receivers:
      prometheus:
        config:
          global:
            scrape_interval: 30s
          scrape_configs:
            - job_name: montra-api
              metrics_path: /internal/metrics
              authorization:
                type: Bearer
                credentials: $${env:METRICS_TOKEN}
              static_configs:
                - targets: ["localhost:4000"]
    processors:
      batch:
        timeout: 30s
    exporters:
      awsemf:
        namespace: ${var.metrics_namespace}
        region: ${local.region}
        log_group_name: /${var.name}/metrics
        log_stream_name: "{TaskId}"
        resource_to_telemetry_conversion:
          enabled: true
        dimension_rollup_option: NoDimensionRollup
        metric_declarations:
          - dimensions: [[queue]]
            metric_name_selectors: ["^montra_job_queue_lag_seconds$"]
          - dimensions: [[]]
            metric_name_selectors: ["^montra_reconciliation_failures$", "^montra_backup_job_failures_total$"]
    service:
      extensions: [health_check]
      pipelines:
        metrics:
          receivers: [prometheus]
          processors: [batch]
          exporters: [awsemf]
  EOT
}
