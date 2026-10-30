/**
 * IAM / CORS documents the customer applies in their own AWS account. Access is
 * limited to the customer's prefix (customers/<customerId>/) in their bucket.
 */

export function customerPrefix(customerId: string): string {
  return `customers/${customerId}/`;
}

export function trustPolicy(portalPrincipalArn: string, externalId: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowTekproDocumentPortal",
        Effect: "Allow",
        Principal: { AWS: portalPrincipalArn },
        Action: "sts:AssumeRole",
        Condition: { StringEquals: { "sts:ExternalId": externalId } },
      },
    ],
  };
}

export function permissionsPolicy(bucket: string, customerId: string, partition = "aws") {
  const prefix = customerPrefix(customerId);
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "PortalObjectAccess",
        Effect: "Allow",
        Action: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
        Resource: `arn:${partition}:s3:::${bucket}/${prefix}*`,
      },
      {
        Sid: "PortalListOwnPrefix",
        Effect: "Allow",
        Action: "s3:ListBucket",
        Resource: `arn:${partition}:s3:::${bucket}`,
        Condition: { StringLike: { "s3:prefix": [`${prefix}*`] } },
      },
    ],
  };
}

/**
 * Name prefix for buckets the portal creates and deletes in a customer's account,
 * e.g. "tekpro-antrix-". The management policy is limited to bucket names with it.
 */
export function managedBucketPrefix(customerCode: string): string {
  return `tekpro-${customerCode.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-`;
}

/**
 * Alternative to permissionsPolicy for customers who let the portal manage their
 * buckets: covers every bucket named <prefix>*, lets the portal create them with
 * private settings, read/write documents under the customer's prefix, and delete
 * a bucket (after removing only the portal's own objects and their versions).
 */
export function bucketManagementPolicy(bucketPrefix: string, customerId: string, partition = "aws") {
  const prefix = customerPrefix(customerId);
  const buckets = `arn:${partition}:s3:::${bucketPrefix}*`;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "PortalManageBuckets",
        Effect: "Allow",
        Action: [
          "s3:CreateBucket",
          "s3:DeleteBucket",
          "s3:PutBucketPublicAccessBlock",
          "s3:PutBucketOwnershipControls",
          "s3:PutEncryptionConfiguration",
          "s3:PutBucketVersioning",
          "s3:PutBucketCORS",
        ],
        Resource: buckets,
      },
      {
        Sid: "PortalObjectAccess",
        Effect: "Allow",
        Action: [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:DeleteObjectVersion",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
        ],
        Resource: `${buckets}/${prefix}*`,
      },
      {
        Sid: "PortalListOwnPrefix",
        Effect: "Allow",
        Action: ["s3:ListBucket", "s3:ListBucketVersions"],
        Resource: buckets,
        Condition: { StringLike: { "s3:prefix": [`${prefix}*`] } },
      },
    ],
  };
}

export function corsConfiguration(appOrigin: string) {
  return {
    CORSRules: [
      {
        AllowedOrigins: [appOrigin],
        AllowedMethods: ["PUT", "GET", "HEAD"],
        AllowedHeaders: ["*"],
        ExposeHeaders: ["ETag"],
        MaxAgeSeconds: 3000,
      },
    ],
  };
}

/** Converts an STS caller ARN into the principal ARN to use in a role trust policy. */
export function trustPrincipalFromCallerArn(arn: string): string {
  const m = /^arn:(aws[a-z-]*):sts::(\d{12}):assumed-role\/([^/]+)\/.+$/.exec(arn);
  return m ? `arn:${m[1]}:iam::${m[2]}:role/${m[3]}` : arn;
}
