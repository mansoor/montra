module "stack" {
  source = "../../modules/stack"

  providers = {
    aws                = aws
    aws.replica        = aws.replica
    aws.backup_account = aws.backup_account
  }

  environment = "prod"
  vpc_cidr    = "10.40.0.0/16"
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

  db_instance_class = "db.r6g.xlarge"
  db_instance_count = 2

  # BAK-02. The compliance-mode lock becomes permanent after the cooling-off period. Read
  # docs/runbooks/first-time-setup.md before the first apply.
  cross_account_backup_enabled = true
  backup_account_id            = var.backup_account_id
  vault_lock_enabled           = true

  services = {
    api            = { cpu = 1024, memory = 2048, min = 2, max = 12 }
    worker         = { cpu = 1024, memory = 2048, min = 2, max = 20 }
    web            = { cpu = 1024, memory = 2048, min = 2, max = 8 }
    doc_worker     = { cpu = 2048, memory = 4096, desired = 2 }
    kratos         = { cpu = 512, memory = 1024, desired = 2 }
    kratos_courier = { cpu = 256, memory = 512 }
  }
}
