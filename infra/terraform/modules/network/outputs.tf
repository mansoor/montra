output "vpc_id" {
  description = "VPC id."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "VPC CIDR block."
  value       = aws_vpc.this.cidr_block
}

output "private_subnet_ids" {
  description = "Subnets for the Fargate tasks."
  value       = [for subnet in aws_subnet.private : subnet.id]
}

output "database_subnet_ids" {
  description = "Subnets for Aurora. They have no route to the internet."
  value       = [for subnet in aws_subnet.database : subnet.id]
}

output "app_security_group_id" {
  description = "Security group shared by the application tasks."
  value       = aws_security_group.app.id
}

output "alb_arn_suffix" {
  description = "ALB identifier used in CloudWatch metric dimensions."
  value       = aws_lb.this.arn_suffix
}

output "alb_dns_name" {
  description = "ALB DNS name, the target of the proxied Cloudflare records."
  value       = aws_lb.this.dns_name
}

output "https_listener_arn" {
  description = "HTTPS listener that the compute module adds host rules to."
  value       = aws_lb_listener.https.arn
}

output "test_listener_arn" {
  description = "Listener for CodeDeploy's test route."
  value       = aws_lb_listener.test.arn
}
