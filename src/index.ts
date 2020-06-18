import * as fsExtra from 'fs-extra';
import * as glob from 'glob';
import { load } from 'load-git';
import { loadHttp, LoadRes } from '@yunke/load-http'
import * as path from 'path';
import * as protobufjs from 'protobufjs';
import { Root } from 'protobufjs';
const queryString = require('query-string')


export { loadFromJson, createPackageDefinition } from './loader';

const CACHE_DIR = `${process.cwd()}/.load-proto-cache`;

async function pbjs(
  protoDirs: string[],
  includeDir: string,
  resolvePath?: (origin: string, target: string, rootDir: string) => string | null | undefined | void,
): Promise<Root> {
  const protoFiles: string[] = [];
  await Promise.all(protoDirs.map((dir) => {
    return new Promise((resolve, reject) => {
      glob(`${dir}/**/*.proto`, (err, matches) => {
        if (err) {
          reject(err);
          return;
        }
        protoFiles.push(...matches);
        resolve(matches);
      });
    });
  }));

  const root = new protobufjs.Root();
  root.resolvePath = (origin, target) => {
    if (resolvePath) {
      const customerResolvePath = resolvePath(origin, target, includeDir);
      if (customerResolvePath) {
        return customerResolvePath;
      }
    }

    if (/^google\/(protobuf|api)/.test(target)) {
      return path.join(
        path.dirname(require.resolve('protobufjs')),
        target,
      );
    } else if (origin) {
      return path.join(
        includeDir,
        target,
      );
    }
    return path.join(target);
  };

  return new Promise<any>((resolve, reject) => {
    root.load(
      protoFiles,
      {
        keepCase: true,
        alternateCommentMode: true,
      },
      (err, res) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(res);
      },
    );
  });
}

interface IGitConfig {
  branch?: string;
  accessToken?: string;
}

interface IGitConfigWithUrl extends IGitConfig {
  url: string;
}


interface GitUrlInterface extends IGitConfigWithUrl {
  protoType?: string;
  lib?: string;
}


export interface IOption extends IGitConfig {
  gitUrls: Array<IGitConfigWithUrl | string>;
  resolvePath?: (origin: string, target: string, rootDir: string) =>
    string | null | undefined | void;
}

export async function loadProto(opt: IOption): Promise<Root> {
  const {
    gitUrls,
    branch,
    accessToken,
    resolvePath,
  } = opt;

  const handleGitUrlQuery = (gitUrl: string): string => {
    const parsed = queryString.parse(gitUrl) || {};
    const { protoType = '' } = parsed
    return protoType
  }

  const loadRes = await Promise.all(gitUrls.map((gitUrl: string | GitUrlInterface) => {
    if (typeof gitUrl === 'string') {
      if (branch) {
        const protoType = handleGitUrlQuery(gitUrl)
        return protoType === 'http' ?
          loadHttp({ url: gitUrl, accessToken, branch, protoType }) :
          load({ url: gitUrl, accessToken, branch })
      }
      throw new Error(`git url ${gitUrl} must specified a branch`);
    }
    const url = gitUrl.url;
    let branch1 = gitUrl.branch;
    let accessToken1 = gitUrl.accessToken;
    if (typeof branch1 === 'undefined') {
      branch1 = branch;
    }
    if (typeof accessToken1 === 'undefined') {
      accessToken1 = accessToken;
    }

    if (branch1) {
      const protoType = gitUrl.protoType || handleGitUrlQuery(url)
      return protoType === 'http' ?
        loadHttp({ url, accessToken: accessToken1, branch: branch1, protoType }) :
        load({ url, accessToken: accessToken1, branch: branch1 })
    }
    throw new Error(`git url ${url} must specified a branch: ${branch1}`);
  }));

  const tempDir = `${CACHE_DIR}/${Math.random()}-${Date.now()}`;


  const deleteLoadGitCache = (dir: string[]) => {
    if (!dir || !dir.length) return
    dir.forEach(async (item: string) => await fsExtra.remove(item))
  }

  const httpLoadGitCache: string[] = []

  try {
    await fsExtra.mkdirp(tempDir);

    const copyDirs = await Promise.all(loadRes.map(async (res: LoadRes) => {

      if (res.protoType === 'http') httpLoadGitCache.push(res.parentDir)

      const dest = `${tempDir}/${path.relative(res.parentDir, res.path)}`;

      await fsExtra.mkdirp(dest);

      await new Promise((resolve, reject) => {
        fsExtra.copy(res.path, dest, (err: Error) => {
          if (err) {
            reject(err);
          }
          resolve();
        });
      });
      return dest;
    }));

    const root = await pbjs(copyDirs, tempDir, resolvePath);

    try {
      await fsExtra.remove(tempDir);
      deleteLoadGitCache(httpLoadGitCache)
    } catch (e) {
      // nothing
    }

    return root;
  } catch (e) {
    await fsExtra.remove(tempDir);
    deleteLoadGitCache(httpLoadGitCache)
    throw e;
  }
}
