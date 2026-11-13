variable "name" {
  description = "Prefix for resource names, for example montra-prod."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC. Must be at least a /20 so each subnet tier can take a /24 per AZ."
  type        = string
}

variable "availability_zone_count" {
  description = "How many availability zones to spread subnets across."
  type        = number
  default     = 3

  validation {
    condition     = var.availability_zone_count >= 2
    error_message = "Use at least two availability zones: the ALB and Aurora need them."
  }
}

variable "single_nat_gateway" {
  description = "Use one NAT gateway instead of one per AZ. Cheaper, but an AZ failure cuts egress. Use for dev only."
  type        = bool
  default     = false
}

variable "certificate_arn" {
  description = "ARN of the validated ACM certificate for the HTTPS listener."
  type        = string
}

variable "alb_ingress_cidrs" {
  description = "IPv4 ranges allowed to reach the ALB. In practice these are Cloudflare's published ranges, so the origin can't be reached around the WAF."
  type        = list(string)
}

variable "alb_ingress_ipv6_cidrs" {
  description = "IPv6 ranges allowed to reach the ALB when it is dualstack. Empty for an IPv4 ALB."
  type        = list(string)
  default     = []
}

variable "ssl_policy" {
  description = "ALB TLS policy. The default allows TLS 1.2 and 1.3 only (NFR-01)."
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

variable "deletion_protection" {
  description = "Protect the ALB from deletion."
  type        = bool
  default     = true
}

variable "app_ports" {
  description = "Ports on the application tasks that the ALB may reach."
  type        = list(number)
  default     = [3000, 4000, 4455] # web, API, auth gateway (ADR-0042). Kratos's 4433 is reachable only from tasks.
}
