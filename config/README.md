# Configuration Files

## nginx-ipfs-hotnode.conf.example

This is an **example** nginx configuration file showing a production setup with a domain.

**NOTE:** The actual nginx configuration is generated dynamically during installation based on your choices:
- Domain-based deployment vs IP-only deployment
- SSL/HTTPS vs HTTP only
- Custom domain name

The install script (`scripts/install.sh`) will create the appropriate configuration at:
`/etc/nginx/sites-available/ipfs-hotnode`

## ipfs-hotnode.service

Systemd service file for the hot node application. This is copied to `/etc/systemd/system/` during installation.
