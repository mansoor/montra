output "primary_vault_name" {
  description = "Primary vault name."
  value       = aws_backup_vault.primary.name
}

output "replica_vault_arn" {
  description = "Vault in the second region."
  value       = aws_backup_vault.replica.arn
}

output "cross_account_vault_arn" {
  description = "Vault in the backup account. Null when the cross-account copy is off."
  value       = var.cross_account_copy_enabled ? aws_backup_vault.cross_account[0].arn : null
}
