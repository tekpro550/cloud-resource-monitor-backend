# Deploying on a single VM (Docker Compose)

Runs the whole portal on one Ubuntu VM (Azure, Lightsail, or any other provider) with
Docker Compose. Documents stay in the Lightsail bucket; the VM runs the application and
its database.

```
Browser ──HTTPS──▶ caddy (ports 80/443, automatic Let's Encrypt certificate)
                     └──▶ portal (tekprocloud/tekpro-portal, port 3000, not exposed)
                            └──▶ postgres:16 (data in a Docker volume on the VM's disk, not exposed)
Browser ──HTTPS──▶ Lightsail bucket (direct uploads/downloads with pre-signed URLs)
```

Files in `deploy/vm/`:

| File | Purpose |
|---|---|
| `docker-compose.yml` | The three services, health checks, hardening (read-only, non-root, no capabilities), log rotation |
| `Caddyfile` | HTTPS reverse proxy for `DOMAIN` |
| `.env.example` | Settings; `setup.sh` turns it into `.env` |
| `setup.sh` | Installs Docker, creates `.env` with generated secrets, opens the firewall, schedules backups, starts the portal |
| `backup.sh` | Database backup (nightly via cron), local retention, optional off-site copy to a bucket |
| `restore.sh` | Restores a backup (takes a safety backup first) |

## 1. Create the VM (Azure)

Azure Portal → **Virtual machines** → **Create** → **Azure virtual machine**:

| Setting | Value |
|---|---|
| Resource group | e.g. `rg-tekpro` |
| Name | e.g. `tekpro-portal-vm` |
| Region | Central India |
| Image | **Ubuntu Server 24.04 LTS - x64 Gen2** |
| Size | **Standard_B2s** (2 vCPU, 4 GiB). B1ms (2 GiB) works for a small pilot; `setup.sh` adds swap below 3 GiB |
| Authentication | SSH public key, username `azureuser`, *Generate new key pair* (download the `.pem`) |
| Inbound ports | SSH (22), HTTP (80), HTTPS (443) |
| Disks | OS disk *Premium SSD* (or Standard SSD), default size is fine |

After it is created:

1. VM → **Overview** → click the **Public IP address** → **Configuration**:
   set **Assignment = Static** and a **DNS name label**, e.g. `tekpro-portal`. The VM is then reachable at
   `tekpro-portal.centralindia.cloudapp.azure.com`. Use that as `DOMAIN`, or your own domain (see §6).
2. Recommended: VM → **Networking** → edit the SSH (22) rule so **Source** is *My IP address* only.

## 2. Copy the deployment files to the VM

On your Mac, in the `tekpro-document-portal` folder of the repository:

```bash
chmod 400 ~/Downloads/tekpro-portal-vm_key.pem
```

```bash
scp -i ~/Downloads/tekpro-portal-vm_key.pem -r deploy/vm azureuser@<VM-IP>:~/tekpro-portal
```

## 3. Run the setup

```bash
ssh -i ~/Downloads/tekpro-portal-vm_key.pem azureuser@<VM-IP>
```

```bash
cd ~/tekpro-portal && sudo ./setup.sh
```

It asks for:

- **Portal host name**, e.g. `tekpro-portal.centralindia.cloudapp.azure.com`
- **Email** for certificate notices
- **Lightsail bucket** name, region, access key ID and secret key

It generates the database password and session secret itself and saves everything in
`~/tekpro-portal/.env` (readable only by root).

If the Docker Hub repository is private, the script stops at "Could not pull the images". Log in
(use a Docker Hub access token as the password) and run the setup again:

```bash
sudo docker login -u tekprocloud
```

```bash
sudo ./setup.sh
```

On success it prints `Portal is running: https://<your host name>`. The first visit can take a few
seconds while the certificate is issued.

To change settings later (e.g. email/SMTP), edit `.env` and apply:

```bash
sudo nano .env
```

```bash
sudo docker compose up -d
```

## 4. Create the first Super Admin

```bash
sudo docker compose run --rm portal bootstrap-superadmin
```

It asks for email, name and password (hidden). This works only once; add further administrators in
the portal. Create a second Super Admin early so one can reset the other's password.

## 5. Allow browser uploads to the bucket

Add `https://<your host name>` to the Lightsail bucket's CORS allowed origins
(rule as in `deploy/s3-bucket-cors.json`, with `ETag` exposed). Then sign in and upload a test file.

Check storage access from the server:

```bash
sudo docker compose run --rm portal storage-check
```

## 6. Your own domain (e.g. portal.tekpro.com)

1. At your DNS provider, create an **A record** `portal.tekpro.com` → the VM's static public IP.
2. On the VM, set `DOMAIN=portal.tekpro.com` in `.env`, then `sudo docker compose up -d`.
3. Add `https://portal.tekpro.com` to the bucket CORS rule.

Caddy obtains the new certificate automatically. Links in emails sent earlier still point to the old name.

## 7. Operations

Run these in `~/tekpro-portal`:

| Task | Command |
|---|---|
| Status | `sudo docker compose ps` |
| Logs (follow) | `sudo docker compose logs -f portal` |
| Restart | `sudo docker compose restart portal` |
| Stop / start everything | `sudo docker compose down` / `sudo docker compose up -d` (data is kept) |
| Update to a new version | set `PORTAL_IMAGE=tekprocloud/tekpro-portal:<new tag>` in `.env`, then `sudo docker compose pull && sudo docker compose up -d` |
| Roll back | set the previous tag and run the same commands (see the migration note below) |
| Back up now | `sudo ./backup.sh` |
| Restore | `sudo ./restore.sh backups/<file>.dump` |
| Storage reconciliation | `sudo docker compose run --rm portal jobs reconcile` |
| Disk usage | `df -h /` and `sudo docker system df` |
| OS updates | `sudo apt update && sudo apt upgrade`, then `sudo reboot` when asked (Ubuntu installs security updates automatically) |

The services restart automatically after a crash or VM reboot. Maintenance jobs (expired uploads,
purging deleted documents, pruning sessions) run inside the portal every 15 minutes.

**Migrations:** a new version applies its database migrations when it starts. Rolling back the image
does not undo them, so take a backup (`sudo ./backup.sh`) before every update.

## 8. Backups

- `backup.sh` runs nightly at 02:15 UTC (`/etc/cron.d/tekpro-portal-backup`, log in
  `/var/log/tekpro-portal-backup.log`). It writes `backups/tekpro_portal-<time>.dump`, checks the
  archive can be read, and deletes local backups older than `BACKUP_RETENTION_DAYS` (14).
- **Off-site copy (strongly recommended):** a backup that exists only on the VM is lost with the VM. Create a
  **separate** bucket (not the documents bucket) with its own access key, and set `BACKUP_S3_BUCKET`,
  `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID` and `BACKUP_S3_SECRET_ACCESS_KEY` in `.env`. Each backup is
  then also copied there.
- **Keep a copy of `.env`** in a password manager. Restoring on a new VM needs the same
  `SESSION_SECRET` and `CONNECTOR_ENCRYPTION_KEY` (if used).
- Optional extra layer: Azure Backup for the VM (VM → **Backup**), which snapshots the whole disk.
- Documents are in the bucket and are not part of these backups; see BACKUP_RECOVERY.md (bucket versioning).

**Moving to a new VM:** run steps 1–3 on the new VM with the old `.env`, copy a backup file over and run
`sudo ./restore.sh <file>`, then point DNS at the new VM.

## 9. Security notes

- Only Caddy is reachable from outside (80/443). PostgreSQL and the portal listen only on the internal
  Docker network.
- The portal container runs as a non-root user with a read-only filesystem, no Linux capabilities and
  `no-new-privileges`.
- `.env` and `backups/` are readable only by root.
- `TRUST_PROXY=1` trusts exactly one proxy hop (Caddy), so rate limits and the audit log see real client IPs.
- The portal connects to PostgreSQL as the database's owner account. It is reachable only from inside the
  Docker network.
- Restrict SSH to your IP address (§1) and keep the `.pem` key private.

## 10. Verified

The stack was tested with `setup.sh` (run twice, to check it is safe to re-run), Caddy HTTPS (internal
test certificate), the interactive first-admin command, the 13-step browser smoke test over HTTPS
(13/13), backup with off-site copy, restore (data and audit-log protection triggers restored), and data
surviving `docker compose down`/`up`. The test used an S3 emulator instead of Lightsail and could not
test Let's Encrypt issuance on a public domain or the Docker installation on a fresh Ubuntu VM.
