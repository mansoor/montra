output "bucket_name" {
  description = "Primary bucket name. Set as S3_BUCKET."
  value       = aws_s3_bucket.primary.id
}

output "bucket_arn" {
  description = "Primary bucket ARN."
  value       = aws_s3_bucket.primary.arn
}

output "replica_bucket_name" {
  description = "Replica bucket name, in the second region."
  value       = aws_s3_bucket.replica.id
}
