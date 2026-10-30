# Tekpro Document Portal — Product Requirements Document (PRD)

**Product Owner:** Tekkonnectpro IT Services (Tekpro)
**Product Name:** Tekpro Document Portal
**Initial Customer:** Antrix
**Document Version:** 1.0
**Status:** Development Specification

## 1. Executive Summary

Tekpro Document Portal is a secure, web-based document distribution platform that enables Tekpro to upload, organise and distribute documents to its customers through controlled, authenticated access.

The application uses Amazon Lightsail Object Storage as its document storage backend. A relational database manages users, customer accounts, folder structures, access permissions, document metadata and audit records.

Tekpro administrators manage the platform and upload documents. Designated Tekpro staff are restricted to the customers assigned to them. Customer users can view and download authorised documents but cannot upload, modify or delete documents.

The platform must support multiple customers so Tekpro can onboard additional organisations without redesigning the application.

## 2. Business Objectives

1. Provide customers with a centralised, secure location to download documents.
2. Allow Tekpro to manage document distribution without relying on email attachments or public file-sharing links.
3. Separate customer data and permissions.
4. Restrict Tekpro staff to assigned customer accounts.
5. Give customer users download-only access.
6. Support daily uploads of at least 3 GB, with the architecture capable of scaling beyond this baseline.
7. Provide an audit trail of document uploads, downloads and administrative actions.
8. Minimise ongoing infrastructure and storage management overhead.
9. Support future customer onboarding without major application changes.

## 3. Scope

### 3.1 In Scope

Secure login and logout · user account management · customer account management · role-based access control · customer assignment for Tekpro staff · folder and subfolder management · document uploads to Amazon Lightsail Object Storage · document listing and metadata management · secure document downloads · customer-specific and folder-specific permissions · search, filtering and sorting · audit logging · password reset and account status management · responsive web interface · deployment documentation · database migrations and initial Super Admin provisioning · error handling, validation and security controls · operational logging and health checks.

### 3.2 Out of Scope for Version 1

Customer document uploads · customer document editing or deletion · real-time collaborative editing · document version comparison and collaborative editing · built-in document preview for every file type · electronic signatures · OCR and AI-based document extraction · public, unauthenticated document links · billing and subscription management · native mobile applications · automated malware scanning unless separately integrated and configured · integration with third-party identity providers unless approved for a later release.

## 4. User Roles

### 4.1 Tekpro Super Admin

The highest-privilege platform role. Permissions: access all customer accounts; create, update, activate and deactivate customer accounts; create, update, activate and deactivate Tekpro staff accounts; assign and unassign customers to designated Tekpro users; create and manage folder structures for all customers; upload documents for all customers; download documents across all customers; rename, move and delete documents; manage document permissions; manage customer user accounts; view audit logs across the platform; view storage usage and document statistics; configure system settings available in the administration interface.

The initial Super Admin must be provisioned through a secure administrative process. The application must not contain a publicly known default administrator password.

### 4.2 Designated Tekpro User

A staff member who manages documents for customers assigned by the Super Admin.

Permissions: view assigned customer accounts only; browse assigned customers' folders; create folders and subfolders within assigned customer accounts; upload documents to assigned customers; download documents for assigned customers; rename, move and delete documents within assigned customers, subject to any additional permissions configured by the Super Admin; view audit records limited to assigned customers, if that feature is enabled.

Restrictions: cannot create customer accounts; cannot create or manage Tekpro staff accounts; cannot assign customers to themselves or other staff; cannot access unassigned customers; cannot modify platform-wide settings; cannot grant themselves additional permissions; cannot change their own role; cannot bypass restrictions by changing URLs, document identifiers or API request parameters.

Customer assignments must be enforced on the backend for every relevant operation.

### 4.3 Antrix Admin

An administrative contact within the Antrix customer organisation.

Permissions: log in securely; view the Antrix document portal; browse folders and subfolders made available to Antrix; search and filter available documents; download authorised documents; view document names, sizes, upload dates and other approved metadata; view relevant download history for their customer account, if enabled.

Restrictions: cannot upload documents; cannot create, rename or delete folders; cannot create or manage users; cannot rename, move or delete documents; cannot change permissions; cannot access another customer account; cannot access private storage credentials; cannot generate arbitrary storage links; cannot administer the platform.

Antrix Admin is a customer administrator from a business perspective, but is not a platform administrator.

### 4.4 Antrix Customer User

Permissions: log in securely; browse folders assigned to their account; view documents permitted by their folder-level access; search and filter permitted documents; download authorised documents; view approved document metadata.

Restrictions: cannot upload documents; cannot create or manage folders; cannot create users; cannot rename, move or delete documents; cannot change permissions; cannot view unassigned folders or documents; cannot access another customer account.

## 5. Role and Permission Matrix

| Function | Tekpro Super Admin | Designated Tekpro User | Antrix Admin | Antrix Customer User |
|---|---|---|---|---|
| Manage customer accounts | All | No | No | No |
| Manage Tekpro staff | All | No | No | No |
| Assign customers to staff | Yes | No | No | No |
| Manage Antrix users | Yes | No | No | No |
| Browse customers | All | Assigned only | Antrix only | Antrix only |
| Create folders | All customers | Assigned customers | No | No |
| Upload documents | All customers | Assigned customers | No | No |
| Download documents | All customers | Assigned customers | Permitted documents | Assigned folders |
| Rename documents | All customers | Assigned customers | No | No |
| Move documents | All customers | Assigned customers | No | No |
| Delete documents | All customers | Assigned customers | No | No |
| Set customer folder access | Yes | No | No | No |
| View platform audit logs | All | Assigned customers, if enabled | Customer-level, if enabled | Own permitted activity, if enabled |
| Change system configuration | Yes | No | No | No |

The backend must implement permissions independently of the frontend.

## 6. Customer and Tenant Architecture

The application must use a multi-tenant data model. A tenant represents a customer organisation, such as Antrix. Every customer-owned folder, document, user and relevant audit event must be associated with the appropriate customer account.

Mandatory rules:

1. Every customer-owned resource must have a customer or tenant identifier.
2. A customer user must never access another customer's documents.
3. A designated Tekpro User must access only customers assigned by the Super Admin.
4. Customer assignment must not automatically grant access to unrelated customers.
5. Folder permissions must be checked independently of customer assignment.
6. Database queries must enforce tenant boundaries.
7. Storage object keys must use a predictable internal namespace that does not expose sensitive information.
8. The backend must never trust a tenant ID supplied by the browser without verifying the authenticated user's access.
9. A document's storage key must not be sufficient on its own to obtain access.
10. Access must be revoked when an account is deactivated or a permission is removed.

Logical storage structure: `customers/{internal-customer-id}/documents/{internal-document-id}`. The actual object key must be generated and controlled by the backend rather than accepted as an arbitrary user-supplied path.

## 7. Folder Management

### 7.1 Folder Features

Create folders and subfolders · display folders in a tree structure · navigate through folder hierarchies · rename folders · move folders where permitted · delete folders where permitted · display document counts · display folder creation and modification dates · apply folder-level customer access · prevent folder names and paths from being used to escape the authorised namespace.

### 7.2 Folder Rules

Folder names must be validated. A folder must belong to a customer. Parent and child folders must belong to the same customer. Cyclic folder hierarchies must be prohibited. Folder deletion must not silently remove unrelated documents. If a folder contains documents, the system must require an explicit deletion policy. The application must prevent accidental bulk deletion. Moving a folder must not expose its contents to unauthorised users.

### 7.3 Customer Folder Permissions

The Super Admin must be able to assign customer users to specific folders. Possible permission values: no access; view folder and metadata; download documents. Customer roles remain download-only. Folder assignments may restrict access further, but must never grant upload, modification or deletion rights. The Antrix Admin can browse all folders explicitly enabled for the Antrix organisation, subject to the organisation's configured access policy. Antrix Customer Users can be restricted to individually assigned folders.

## 8. Document Management

### 8.1 Uploading

Only the Tekpro Super Admin and designated Tekpro Users with access to the target customer may upload documents. Required functionality: file selection; drag-and-drop upload; upload progress; file size validation; file type validation according to configurable policy; duplicate-name handling; upload cancellation where technically supported; retry handling for failed uploads; success and failure notifications; upload metadata persistence; storage integrity verification; audit event creation.

### 8.2 Upload Performance

The application must accommodate at least 3 GB of new uploads per day. The design must not route large file contents through the Node.js application server unnecessarily. Use direct-to-object-storage uploads with short-lived, server-generated pre-signed upload requests where supported by the configured Lightsail S3-compatible API. For large files, use multipart uploads if supported by the chosen storage API and client library. Before implementing multipart upload, validate the actual API capabilities and limitations of the selected Lightsail Object Storage configuration. If multipart uploads are unsupported or unsuitable, implement a documented alternative and its size limitations. The application must not load entire large files into memory.

### 8.3 Document Metadata

Each document record must include: internal document ID; customer ID; folder ID; display filename; internal object key; MIME type; file size in bytes; upload timestamp; uploader user ID; last modification timestamp; optional checksum; document status; optional description; optional retention or deletion metadata. The database must not store file contents.

### 8.4 Document Actions

The Super Admin and authorised designated Tekpro Users may upload, download, rename, move and delete documents. Customer users may view permitted metadata and download authorised documents. Customer users must not be able to modify file contents or document metadata.

### 8.5 Deletion

Document deletion must be controlled and auditable. The application must: (1) verify the user's role and customer assignment; (2) verify access to the target document; (3) record the deletion request; (4) delete or quarantine the object according to the configured deletion policy; (5) update the database consistently; (6) handle failures between database and storage operations; (7) record the final result. Do not assume database transactions can atomically include object storage operations. Implement a recoverable workflow for partial failures. If soft deletion is enabled, the UI must clearly distinguish deleted documents from active documents.

## 9. Secure Document Downloads

All document downloads must pass through a backend authorisation check. Required sequence: (1) user requests a document download; (2) backend authenticates the user; (3) backend loads the document metadata; (4) backend verifies the user's customer access; (5) backend verifies folder-level permission where applicable; (6) backend confirms that the document is available; (7) backend generates a short-lived pre-signed download URL; (8) the browser downloads the file from object storage; (9) the application records the download event.

Download URLs must expire after a configurable short period, initially five minutes.

The application must not: make the bucket public; return permanent object URLs for private documents; allow a user to download a document by guessing its identifier; generate a download link without authorisation; trust client-provided object keys; expose storage credentials in browser code or logs.

A pre-signed URL is a bearer credential while valid; keep its lifetime short and avoid logging complete URLs or exposing them unnecessarily. If the storage API or download configuration does not support the expected pre-signed URL behaviour, document the limitation and implement an appropriate secure alternative.

## 10. Authentication and Account Management

### 10.1 Authentication

Email-based login; secure password storage; logout; session expiry; account activation and deactivation; password reset; protection against repeated failed login attempts; secure session handling; server-side authorisation on protected routes. Use a maintained authentication library or a well-reviewed authentication pattern. Passwords must be hashed with Argon2id or bcrypt with an appropriate work factor. Never store plaintext passwords.

### 10.2 Session Security

Prefer secure, HttpOnly cookies with appropriate SameSite settings and CSRF protection where required. Production cookies must use the Secure attribute over HTTPS. Use session rotation or equivalent protection after authentication and privilege changes. Invalidate sessions when accounts are deactivated or when security-sensitive changes require revocation.

### 10.3 User Administration

The Super Admin must be able to: create users; assign a role; assign a customer where applicable; assign a designated Tekpro User to one or more customers; assign customer users to permitted folders; activate or deactivate accounts; trigger password reset workflows; review account activity. A customer user must not be able to modify their role, customer assignment or folder permissions. The application must enforce a single controlled bootstrap process for the initial Super Admin. It must not recreate the Super Admin on every server startup or allow unauthenticated promotion to the Super Admin role.

## 11. Search and Filtering

Search by filename; filter by folder; filter by file type; filter by upload date; sort by filename, file size and upload date; paginated document listings. Search results must respect all tenant, role and folder permissions. A search query must never reveal the existence or metadata of an inaccessible document.

## 12. Audit Logging

Events: successful and failed logins; logout events where appropriate; user creation and deactivation; role changes; customer assignments; folder creation, renaming, moving and deletion; document uploads; document downloads; document renaming and movement; document deletion; permission changes; failed authorisation attempts; administrative configuration changes.

Fields: event ID; timestamp in UTC; actor user ID where known; customer ID where applicable; event type; resource type; resource ID; outcome; request or correlation ID; source IP where justified and handled under an appropriate privacy policy; safe metadata describing the action.

Never log passwords, authentication tokens, secret keys or complete pre-signed URLs. Audit records must not be editable by ordinary users. The Super Admin must be able to filter audit records by customer, user, action and date.

## 13. Storage Architecture

### 13.1 Storage Service

Use Amazon Lightsail Object Storage with its supported S3-compatible API. Use configuration values rather than hardcoded endpoints: storage endpoint, region, bucket name, access key ID, secret access key, public application URL, allowed upload limits. Use the AWS SDK for JavaScript v3 S3 client where compatible with the selected endpoint. Confirm compatibility with the actual Lightsail Object Storage API before relying on advanced S3 features.

### 13.2 Security

Keep the storage bucket private. Restrict credentials to the backend. Use TLS for application and storage communication. Use least-privilege storage credentials where supported. Rotate credentials when necessary. Keep secrets out of source control. Never embed credentials in frontend environment variables. Avoid revealing internal object keys to customers unless necessary.

### 13.3 Storage and Database Consistency

Handle situations in which: an upload succeeds but metadata creation fails; metadata creation succeeds but the upload fails; a delete request succeeds in the database but fails in storage; an object exists without a matching database record; a document record refers to a missing object. Implement appropriate upload states, retry logic, cleanup workflows and operational logging.

## 14. Recommended Technology Stack

Frontend: React, TypeScript, Vite, a maintained component library or consistent custom component system, responsive layout, accessible forms/navigation/feedback. Backend: Node.js, TypeScript, Express, REST API, centralised authentication and authorisation middleware, request validation, structured logging, rate limiting. Database: PostgreSQL, Prisma ORM, version-controlled migrations, indexed customer/folder/document relationships, database constraints for essential integrity rules. Object storage: Amazon Lightsail Object Storage, S3-compatible API, AWS SDK for JavaScript v3 (subject to endpoint compatibility testing), private bucket, short-lived pre-signed downloads. Testing: unit, integration, role and permission, API security, upload and download, cross-customer isolation, deployment smoke tests. Exact package versions are selected during implementation and locked in the lockfile.

## 15. High-Level Architecture

Components: React web frontend; Node.js API service; PostgreSQL database; Lightsail Object Storage; authentication and authorisation middleware; audit logging subsystem; background cleanup or reconciliation tasks.

Upload flow: Tekpro User → React Frontend → Node.js API → Authorisation Check → Short-Lived Upload Request → Lightsail Object Storage → Metadata Finalisation → Audit Event.

Download flow: Customer User → React Frontend → Node.js API → Tenant and Folder Permission Check → Short-Lived Download URL → Lightsail Object Storage → Audit Event.

A generated URL alone does not prove the file was completely downloaded. Do not report a download as completed unless the system has a reliable way to establish completion.

## 16. Database Model

User (id, email, passwordHash, fullName, role, status, createdAt, updatedAt, lastLoginAt) · Customer (id, name, customerCode, status, createdAt, updatedAt) · TekproUserCustomerAssignment (id, userId, customerId, assignedByUserId, createdAt) · Folder (id, customerId, parentFolderId, name, createdByUserId, createdAt, updatedAt, deletedAt) · Document (id, customerId, folderId, displayName, objectKey, mimeType, sizeBytes, checksum, status, uploadedByUserId, createdAt, updatedAt, deletedAt) · CustomerUserFolderPermission (id, userId, folderId, permission, grantedByUserId, createdAt, updatedAt) · AuditLog (id, actorUserId, customerId, action, resourceType, resourceId, outcome, requestId, ipAddress, metadata, createdAt) · authentication and session entities as required.

The application must define whether permissions are inherited from parent folders; the recommended default is explicit, well-documented inheritance with the ability to restrict access further. An explicit denial must never be overridden by a broader permission. Use random, non-guessable identifiers. Enforce uniqueness and referential integrity in the database.

## 17. User Interface Requirements

- **Login page:** Tekpro branding, email, password, login button, password reset option, clear validation and authentication errors.
- **Super Admin dashboard:** total customers, total active users, total documents, storage usage, recent uploads, recent download requests, recent administrative events, customer management, user management, audit logs.
- **Tekpro User dashboard:** assigned customers, customer folders, upload button, folder creation controls, document list, upload progress, relevant audit information. Do not display unassigned customers.
- **Customer dashboard:** customer name, available folders, breadcrumb navigation, search and filtering, document name, file size, upload date, download button, download status. Customer screens must not display upload, edit, rename, move, delete or permission-management controls.
- **Responsive behaviour:** current desktop and modern mobile browsers; browser-native downloads; do not load large files into browser memory.

## 18. API Requirements

Versioned REST API (`/api/v1`) with authentication, customers, users, folders, documents (including upload initiation/completion and download) and audit endpoints. Every endpoint must have a clearly defined permission policy. Upload completion endpoints must verify the resulting object and its expected size or checksum where available and must not trust a client assertion that an upload succeeded. (Implemented endpoints: [API.md](API.md).)

## 19. Error Handling

Handle invalid credentials, expired sessions, inactive accounts, missing documents/folders, insufficient permissions, storage timeouts, failed uploads/downloads, database connection failures, duplicate filenames, invalid file types, size limit violations, invalid folder relationships, concurrent modifications and partial storage/database failures. Return appropriate HTTP status codes and safe, consistent error messages; never expose stack traces, database details, secrets or storage credentials in production responses.

## 20. Non-Functional Requirements

Security (server-side RBAC, tenant isolation, input validation, HTTPS, session protection, rate limits, common web vulnerability protection, dependency updates, secrets outside the repository, secure defaults) · Performance (≥ 3 GB/day uploads, pagination, no full documents in application memory, indexes, concurrent users subject to capacity, defined and tested upload-size and concurrency limits) · Reliability (health checks, operational failure logging, transient storage failure handling, retry-safe operations, database backups, recovery procedures, reconciliation) · Accessibility and usability (clear navigation, upload/download status, understandable permission errors, keyboard navigation, readable typography and contrast, prevention of accidental destructive actions).

## 21. Deployment Requirements

Frontend build configuration; backend production configuration; PostgreSQL setup; database migrations; environment variable documentation; secure initial Super Admin creation; HTTPS and domain guidance; storage bucket configuration; logging and health checks; backup and recovery guidance; deployment and rollback instructions. Lightsail Object Storage does not host the application or database.

## 22. Acceptance Criteria

- **Authentication:** log in/out; secure password hashing; inactive accounts blocked; unauthenticated API access blocked; sessions expire and can be revoked.
- **Authorisation:** Super Admin manages all customers; Tekpro Users manage only assigned customers; Antrix Admin cannot upload, rename, move or delete; Antrix Customer Users download only from permitted folders; no customer user can create accounts or change permissions; direct API requests cannot bypass UI restrictions.
- **Tenant isolation:** changing document, folder or customer IDs grants no access; search does not disclose unauthorised metadata.
- **Storage:** private bucket; uploads in Lightsail; metadata in PostgreSQL; short-lived authorised download links; large files bypass server memory; failed uploads and deletions are recoverable.
- **Audit:** uploads, downloads, permission changes and administrative actions logged without secrets or full pre-signed URLs.
- **User experience:** role-appropriate actions; searchable, paginated lists; visible upload progress and errors; usable on desktop and mobile.
- **Delivery:** complete source; documented configuration; working migrations; passing tests; complete deployment instructions; no committed secrets or default passwords; secure Super Admin provisioning.

## 23. Key Implementation Decisions

1. Multi-tenant architecture from the beginning. 2. Private object storage bucket. 3. File contents in object storage, metadata in PostgreSQL. 4. Backend-enforced permissions for every protected operation. 5. Tekpro Users restricted to assigned customers. 6. All Antrix users download-only. 7. Short-lived download links. 8. Direct or multipart uploads where supported. 9. Controlled Super Admin bootstrap. 10. Automated tests for role enforcement and customer isolation. 11. Extensible for additional customers. 12. Validate actual storage API capabilities before relying on optional S3 features.

---

## Appendix: how open points were resolved in the implementation

| PRD point | Decision |
|---|---|
| Permission inheritance (§16) | Grants inherit downward; nearest explicit grant wins; `NONE` on a folder or ancestor denies the subtree and cannot be overridden (see SECURITY.md) |
| "Folders explicitly enabled for Antrix" (§7.3) | Folders are visible to the customer organisation unless the Super Admin marks them `hiddenFromCustomer` (inherited) |
| Staff deletion "subject to additional permissions" (§4.2) | Super Admin settings `staffCanDeleteDocuments` / `staffCanDeleteFolders` |
| "If enabled" audit access (§5) | Settings `staffAuditAccess` (default on), `customerAdminActivityAccess` (default on), `customerUserActivityAccess` (default off) |
| Deletion policy (§8.5) | Soft delete with configurable retention, then purge job; restore within retention; storage failures retried and audited |
| Non-empty folder deletion (§7.2) | Requires `recursive` and typing the folder name; documents become recoverable `DELETED`; refused above 5,000 documents |
| Download completion (§15) | Only "download link issued" is recorded; completion is not claimed |
| Checksum (§8.3) | Size and content-signature verification at completion; the storage ETag is stored; a cryptographic checksum column is reserved but not populated in v1 |
| User onboarding | New users receive a single-use invitation link to set their own password; administrators never set passwords |
| Cross-customer moves (§7.2) | Prohibited for all roles in v1 |
