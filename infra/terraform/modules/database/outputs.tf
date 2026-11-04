output "cluster_arn" {
  description = "Cluster ARN, the AWS Backup selection."
  value       = aws_rds_cluster.this.arn
}

output "cluster_identifier" {
  description = "Cluster identifier, for metrics."
  value       = aws_rds_cluster.this.cluster_identifier
}

output "writer_endpoint" {
  description = "Writer endpoint. Goes into every connection string except reporting ones."
  value       = aws_rds_cluster.this.endpoint
}

output "reader_endpoint" {
  description = "Reader endpoint, for reporting queries."
  value       = aws_rds_cluster.this.reader_endpoint
}

output "master_user_secret_arn" {
  description = "Secret holding the master password, managed by RDS."
  value       = aws_rds_cluster.this.master_user_secret[0].secret_arn
}
