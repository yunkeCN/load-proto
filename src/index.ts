import * as fsExtra from 'fs-extra';
import * as glob from 'glob';
import * as path from 'path';
import * as protobufjs from 'protobufjs';
import { Root } from 'protobufjs';
import { load, LoadRes as LoadResponse } from 'load-git'
const querystring = require('querystring')
const url = require('url')

export { loadFromJson, createPackageDefinition } from './loader';

const CACHE_DIR = `${process.cwd()}/.load-proto-cache`;

interface IProtoDir {
  dir: string;
  rule: string;
}

async function pbjs(
  protoDirs: IProtoDir[],
  includeDir: string,
  resolvePath?: (origin: string, target: string, rootDir: string) => string | null | undefined | void,
): Promise<Root> {
  const protoFiles: string[] = [];
  await Promise.all(protoDirs.map((item) => {
    return new Promise((resolve, reject) => {
      glob(`${item.dir}${item.rule}`, (err, matches) => {
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
  rule?: string;
}

interface IGitConfigWithUrl extends IGitConfig {
  url: string;
}

interface ILoadResult {
  parentDir: string;
  path: string;
  rule?: string;
  clean?: boolean;
}


export interface IOption extends IGitConfig {
  gitUrls: Array<IGitConfigWithUrl | string>;
  resolvePath?: (origin: string, target: string, rootDir: string) =>
    string | null | undefined | void;
  loadProtoPlugin?: (option: IGitConfigWithUrl) => Promise<ILoadResult>
}


export async function loadProto(opt: IOption): Promise<Root> {
  const {
    gitUrls,
    branch,
    accessToken,
    resolvePath,
    loadProtoPlugin
  } = opt;

  const loadRes: ILoadResult[] = await Promise.all(gitUrls.map(async (gitUrl) => {
    if (typeof gitUrl === 'string') {
      if (branch) {
        const options = { url: gitUrl, accessToken, branch }
        if (loadProtoPlugin) {
          const result: ILoadResult = await loadProtoPlugin(options)
          if (result) {
            return await loadProtoPlugin(options)
          }
        }
        return await load(options);
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
      const options = { url: url, accessToken: accessToken1, branch: branch1 }
      if (loadProtoPlugin) {
        const result: ILoadResult = await loadProtoPlugin(options)
        if (result) {
          return {
            ...result,
            rule: gitUrl.rule,
          }
        }
      }
      const loadResponse: LoadResponse = await load(options);
      return {
        parentDir: loadResponse.parentDir,
        path: loadResponse.path,
        rule: gitUrl.rule,
      };
    }
    throw new Error(`git url ${url} must specified a branch: ${branch1}`);
  }));
  const tempDir = `${CACHE_DIR}/${Math.random()}-${Date.now()}`;

  const deleteLoadGitCache = (cachedir: string[]) => {
    if (!cachedir || !cachedir.length) return
    cachedir.forEach(async (item: string) => await fsExtra.remove(item))
  }

  const pluginLoadGitCache: string[] = []

  try {
    await fsExtra.mkdirp(tempDir);

    const copyDirs = await Promise.all(loadRes.map(async (res) => {

      if (res.clean)
        pluginLoadGitCache.push(res.parentDir)

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
      return {
        dir: dest,
        rule: res.rule || '/**/*.proto',
      };
    }));

    const root = await pbjs(copyDirs, tempDir, resolvePath);

    try {
      await fsExtra.remove(tempDir);
      deleteLoadGitCache(pluginLoadGitCache)
    } catch (e) {
      // nothing
    }

    return root;
  } catch (e) {
    await fsExtra.remove(tempDir);
    deleteLoadGitCache(pluginLoadGitCache)
    throw e;
  }
}
