export interface GoogleCredentials {
  email: string;
  refreshToken: string;
  services: string[];
  scopes: string[];
}

export interface CredentialStore {
  getGoogleCredentials(): Promise<GoogleCredentials | null>;
}

/**
 * DynamoDB-backed credential store. Reads tokens written by the proxy's oauth.go
 * (schema: PK=SERVICE#<service>, Provider, AccessToken, RefreshToken, Expiry, Email, Scopes).
 */
class DynamoCredentialStore implements CredentialStore {
  constructor(
    private readonly tableName: string,
    private readonly region: string,
  ) {}

  async getGoogleCredentials(): Promise<GoogleCredentials | null> {
    const { DynamoDBClient, ScanCommand } = await import("@aws-sdk/client-dynamodb");
    const client = new DynamoDBClient({ region: this.region });

    const result = await client.send(new ScanCommand({ TableName: this.tableName }));

    if (!result.Items?.length) return null;

    let email = "";
    let refreshToken = "";
    const services: string[] = [];
    const scopes: string[] = [];

    for (const item of result.Items) {
      const provider = item.Provider?.S ?? "";
      if (provider !== "google") continue;

      const pk = item.PK?.S ?? "";
      if (!pk.startsWith("SERVICE#")) continue;
      const service = pk.slice(8);

      const rt = item.RefreshToken?.S ?? "";
      if (rt && !refreshToken) {
        refreshToken = rt;
        email = item.Email?.S ?? "";
      }

      services.push(service);

      const itemScopes = item.Scopes?.S ?? "";
      if (itemScopes) {
        for (const s of itemScopes.split(",")) {
          if (s && !scopes.includes(s)) scopes.push(s);
        }
      }
    }

    if (!refreshToken) return null;

    return { email, refreshToken, services, scopes };
  }
}

/**
 * Returns a DynamoDB credential store if USER_TOKENS_DYNAMO_TABLE and AWS_REGION are set,
 * otherwise null (non-AWS environments, local dev).
 */
export function createCredentialStore(): CredentialStore | null {
  const table = process.env.USER_TOKENS_DYNAMO_TABLE;
  const region = process.env.AWS_REGION;
  if (!table || !region) return null;
  return new DynamoCredentialStore(table, region);
}
