import * as path from 'path';
import * as glob from 'glob';
import * as protobufjs from 'protobufjs';
import { Root } from 'protobufjs';
import { load } from '@yunke/load-git';
import * as fsExtra from 'fs-extra';

export { loadFromJson, createPackageDefinition } from './loader';

const rmrf = require('rmrf');

const CACHE_DIR = `${process.cwd()}/.load-proto-cache`;

async function pbjs(protoDirs: string[], includeDir: string): Promise<Root> {
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
    if (target.indexOf('google/protobuf') === 0) {
      return `${path.dirname(require.resolve('protobufjs'))}/${target}`;
    } else if (target.indexOf('proto/') === 0) {
      // tslint:disable-next-line variable-name
      return target.replace(/^proto\/([^\/]+)(.+)/, (_target, $1, $2) => {
        return `${includeDir}/git.myscrm.cn/2c/${$1.replace(/_/g, '-')}${$2}`;
      });
    } else if (origin) {
      return `${includeDir}/${target}`;
    }
    return target;
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

export async function loadProto(gitUrls: string[], branch: string, accessToken: string): Promise<Root> {
  const loadRes = await Promise.all([
    load({
      url: 'https://git.myscrm.cn/golang/common.git',
      branch: 'master',
      accessToken,
    })
  ].concat(
      gitUrls.map((gitUrl) => {
        return load({ url: gitUrl, accessToken, branch });
      })
  ));
  const tempDir = `${CACHE_DIR}/${Math.random()}-${Date.now()}`;

  try {
    await fsExtra.mkdirp(tempDir);

    const copyDirs = await Promise.all(loadRes.map(async (res) => {
      const dest = `${tempDir}/${path.relative(res.parentDir, res.path)}`;

      await fsExtra.mkdirp(dest);

      await new Promise((resolve, reject) => {
        fsExtra.copy(res.path, dest, (err) => {
          if (err) {
            reject(err);
          }
          resolve();
        });
      });
      return dest;
    }));

    const root = await pbjs(copyDirs.slice(1), tempDir);

    await fsExtra.remove(tempDir);

    return root;
  } catch (e) {
    rmrf(tempDir);
    throw e;
  }
}
