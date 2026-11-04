module "stack" {
  source = "../../modules/stack"

  providers = {
    aws                = aws
    aws.replica        = aws.replica
    aws.backup_account = aws.backup_account
  }

  environment = "dev"
  vpc_cidr    = "10.20.0.0/16"
  image_tag   = var.image_tag

  domain_name                 = var.domain_name
  cloudflare_zone_id          = var.cloudflare_zone_id
  bucket_prefix               = var.bucket_prefix
  github_repository           = var.github_repository
  create_github_oidc_provider = var.create_github_oidc_provider
  alarm_emails                = var.alarm_emails
  support_email               = var.support_email
  dmarc_report_address        = var.dmarc_report_address

  billing_mode             = var.billing_mode
  stripe_price_pro_monthly = var.stripe_price_pro_monthly
  stripe_price_pro_yearly  = var.stripe_price_pro_yearly

  managed_waf_enabled            = var.managed_waf_enabled
  rate_limit_period_seconds      = var.rate_limit_period_seconds
  rate_limit_count_failures_only = var.rate_limit_count_failures_only

  availability_zone_count = 2
  single_nat_gateway      = true
  protect_from_deletion   = false

  db_instance_class        = "db.t4g.medium"
  db_instance_count        = 1
  db_backup_retention_days = 7

  deployment_config_name = "CodeDeployDefault.ECSAllAtOnce"

  # Dev keeps backups in this account, without a lock: they can be thrown away.
  cross_account_backup_enabled = false
  vault_lock_enabled           = false

  services = {
    api            = { cpu = 512, memory = 1024, min = 2, max = 2 }
    worker         = { cpu = 512, memory = 1024, min = 1, max = 2 }
    web            = { cpu = 512, memory = 1024, min = 1, max = 1 }
    doc_worker     = { cpu = 512, memory = 1024, desired = 1 }
    kratos         = { cpu = 256, memory = 512, desired = 1 }
    kratos_courier = { cpu = 256, memory = 512 }
  }
}
