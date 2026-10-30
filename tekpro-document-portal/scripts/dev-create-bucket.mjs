// Creates the local development buckets on the moto S3 server and allows browser
// uploads from the Vite dev server. Development only.
//   - STORAGE_BUCKET (default tekpro-dev): Tekpro platform storage
//   - customer-demo: stands in for a bucket in a customer's own AWS account, to try
//     the per-customer storage connector locally
import { createRequire } from "node:module";

const require = createRequire(new URL("../backend/package.json", import.meta.url));
const { S3Client, CreateBucketCommand, PutBucketCorsCommand } = require("@aws-sdk/client-s3");

const endpoint = process.env.STORAGE_ENDPOINT ?? "http://localhost:5050";
const bucket = process.env.STORAGE_BUCKET ?? "tekpro-dev";
const origin = process.env.APP_BASE_URL ?? "http://localhost:5173";
const client = new S3Client({
  region: process.env.STORAGE_REGION ?? "us-east-1",
  endpoint,
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? "test", secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? "test" },
});

for (const name of [bucket, "customer-demo"]) {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.send(new CreateBucketCommand({ Bucket: name }));
      break;
    } catch (err) {
      if (err.name === "BucketAlreadyOwnedByYou" || err.name === "BucketAlreadyExists") break;
      if (attempt >= 15) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await client.send(
    new PutBucketCorsCommand({
      Bucket: name,
      CORSConfiguration: {
        CORSRules: [{ AllowedOrigins: [origin], AllowedMethods: ["PUT", "GET", "HEAD"], AllowedHeaders: ["*"], ExposeHeaders: ["ETag"], MaxAgeSeconds: 3000 }],
      },
    }),
  );
  console.log(`Bucket "${name}" ready at ${endpoint} (CORS allows ${origin})`);
}
