# Production Kratos: the local config and templates baked in, with environment-specific values set through
# environment variables by Terraform (infra/terraform/modules/compute/kratos.tf).
# Build from this directory:
#   docker build -t montra/kratos infra/kratos
FROM oryd/kratos:v1.3.1
COPY kratos.yml identity.schema.json /etc/config/kratos/
COPY templates /etc/config/kratos/templates
# Aurora requires TLS. `sslrootcert` in the DSN points here.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/config/kratos/rds-global-bundle.pem
USER 10000
CMD ["serve", "-c", "/etc/config/kratos/kratos.yml"]
