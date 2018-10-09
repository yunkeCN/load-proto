import * as request from "request-promise-native";

const gitHttpReg = /https?:\/\/([^/]+)\/(.+)\.git/;
const gitSshReg = /git@([^:]+):(.+)\.git/;

function getUrlConfig(gitUrl: string): { host: string, repId: string } | null {
  let host = '';
  let repId = '';

  let exec = gitHttpReg.exec(gitUrl);
  if (exec) {
    host = exec[1];
    repId = exec[2];
  }

  if (!exec) {
    exec = gitSshReg.exec(gitUrl);

    if (exec) {
      host = exec[1];
      repId = exec[2];
    }
  }

  if (exec) {
    return { host, repId };
  }
  return null;
}

export function getArchiveUrls(gitUrl: string, branches: string[] = ['master']): string[] | null {
  const config = getUrlConfig(gitUrl);
  if (config) {
    const { host, repId } = config;
    return branches.map((branch) => {
      return `https://${host}/${repId}/repository/${branch}/archive.zip`;
    });
  }
  return null;
}

export async function getBranchLastCommitId(gitUrl: string, branch: string, accessToken?: string): Promise<string | null> {
  const config = getUrlConfig(gitUrl);

  if (config) {
    const { host, repId } = config;

    const uri = `https://${host}/api/v4/projects/${encodeURIComponent(repId)}/repository/branches/${branch}`;

    const res = await request({
      uri,
      qs: { private_token: accessToken },
      json: true,
    });
    return res.commit.id;
  }

  return null;
}
