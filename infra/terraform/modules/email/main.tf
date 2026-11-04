data "aws_region" "current" {}

locals {
  mail_from_domain = "bounce.${var.domain_name}"
  spf_record       = "v=spf1 include:amazonses.com -all"
  dmarc_record     = "v=DMARC1; p=${var.dmarc_policy}; rua=mailto:${var.dmarc_report_address}; adkim=r; aspf=r"
}

resource "aws_ses_domain_identity" "this" {
  domain = var.domain_name
}

resource "aws_ses_domain_dkim" "this" {
  domain = aws_ses_domain_identity.this.domain
}

resource "aws_ses_domain_mail_from" "this" {
  domain           = aws_ses_domain_identity.this.domain
  mail_from_domain = local.mail_from_domain
}

resource "cloudflare_record" "ses_verification" {
  zone_id = var.cloudflare_zone_id
  name    = "_amazonses.${var.domain_name}"
  type    = "TXT"
  content = aws_ses_domain_identity.this.verification_token
  ttl     = 600
  proxied = false
  comment = "SES domain verification, managed by Terraform"
}

# SES always issues three DKIM tokens.
resource "cloudflare_record" "dkim" {
  count = 3

  zone_id = var.cloudflare_zone_id
  name    = "${aws_ses_domain_dkim.this.dkim_tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  content = "${aws_ses_domain_dkim.this.dkim_tokens[count.index]}.dkim.amazonses.com"
  ttl     = 600
  proxied = false
  comment = "SES DKIM (OPS-10), managed by Terraform"
}

resource "cloudflare_record" "mail_from_mx" {
  zone_id  = var.cloudflare_zone_id
  name     = local.mail_from_domain
  type     = "MX"
  content  = "feedback-smtp.${data.aws_region.current.name}.amazonses.com"
  priority = 10
  ttl      = 600
  proxied  = false
  comment  = "SES MAIL FROM, managed by Terraform"
}

resource "cloudflare_record" "spf" {
  zone_id = var.cloudflare_zone_id
  name    = local.mail_from_domain
  type    = "TXT"
  content = local.spf_record
  ttl     = 600
  proxied = false
  comment = "SPF for the SES MAIL FROM domain (OPS-10), managed by Terraform"
}

resource "cloudflare_record" "dmarc" {
  zone_id = var.cloudflare_zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  content = local.dmarc_record
  ttl     = 600
  proxied = false
  comment = "DMARC (OPS-10), managed by Terraform"
}

resource "aws_ses_domain_identity_verification" "this" {
  domain = aws_ses_domain_identity.this.domain

  depends_on = [cloudflare_record.ses_verification]
}
