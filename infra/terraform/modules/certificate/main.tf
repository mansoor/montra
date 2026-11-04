# The ALB's origin certificate. Separate from the network module so that the ALB can wait for validation without a
# dependency cycle between the network and edge modules.
resource "aws_acm_certificate" "this" {
  domain_name               = var.hostnames[0]
  subject_alternative_names = slice(var.hostnames, 1, length(var.hostnames))
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_record" "validation" {
  for_each = {
    for option in aws_acm_certificate.this.domain_validation_options : option.domain_name => {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  }

  zone_id = var.cloudflare_zone_id
  name    = trimsuffix(each.value.name, ".")
  type    = each.value.type
  content = trimsuffix(each.value.value, ".")
  ttl     = 60
  proxied = false
  comment = "ACM validation, managed by Terraform"
}

resource "aws_acm_certificate_validation" "this" {
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [for record in cloudflare_record.validation : record.hostname]
}
