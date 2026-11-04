output "data_key_arn" {
  description = "Key for field-level encryption. Set as AWS_KMS_KEY_ID."
  value       = aws_kms_key.multi_region["data"].arn
}

output "database_key_arn" {
  description = "Key for Aurora and its backups."
  value       = aws_kms_key.multi_region["database"].arn
}

output "database_replica_key_arn" {
  description = "Replica of the database key in the second region."
  value       = aws_kms_replica_key.multi_region["database"].arn
}

output "storage_key_arn" {
  description = "Key for the S3 file bucket."
  value       = aws_kms_key.multi_region["storage"].arn
}

output "storage_replica_key_arn" {
  description = "Replica of the storage key in the second region."
  value       = aws_kms_replica_key.multi_region["storage"].arn
}

output "ops_key_arn" {
  description = "Key for Secrets Manager and the alarm topic."
  value       = aws_kms_key.ops.arn
}
