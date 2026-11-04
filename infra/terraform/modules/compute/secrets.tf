resource "aws_secretsmanager_secret" "this" {
  for_each = local.secret_names

  name                    = "${var.name}/${each.key}"
  description             = "Montra ${var.environment}: ${each.key}. Value set by hand, see docs/runbooks/first-time-setup.md."
  kms_key_id              = var.ops_key_arn
  recovery_window_in_days = var.secret_recovery_window_days
}
