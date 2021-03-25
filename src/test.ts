import * as grpc from "@grpc/grpc-js";
import { Metadata } from "@grpc/grpc-js";
import { loadProto } from "./index";
import { createPackageDefinition } from "./loader";
import { ServiceClientConstructor } from "@grpc/grpc-js/build/src/make-client";
import grpcResolvePath from "@yunke/grpc-resolve-path";
import * as _ from "lodash";

const token = process.argv[2];

loadProto({
  gitUrls: [
    {
      url: "git@git.myscrm.cn:ykcommon/ykproto.git",
      branch: "master",
      accessToken: "oQtW_cxaZXFqQM6xW7LX",
    },
    {
      url: "git@git.myscrm.cn:2g/sms-core-proto.git",
      branch: "master",
      accessToken: "oQtW_cxaZXFqQM6xW7LX",
    },
  ],
  accessToken: token,
  branch: "dev",
  resolvePath: grpcResolvePath,
}).then((root) => {
  console.info(root);
  const packageDefinition = createPackageDefinition(root, {
    longs: Number,
    defaults: true,
  });
  const grpcObject = grpc.loadPackageDefinition(packageDefinition);
  const host = "middleman-grpc-proxy-test.myscrm.cn:9000";
  const methodName = "channel.ChannelSendStatService.InitReceiveCount";

  const split = methodName.split(".");
  const service = split.slice(0, split.length - 1).join(".");
  const method = split[split.length - 1];
  const request = {
    begin_date: "2020-12-25",
    end_date: " 2020-12-25",
  };

  const Service: ServiceClientConstructor = _.get(
    grpcObject,
    service
  ) as ServiceClientConstructor;

  if (!Service) {
    throw new Error(`Service name: ${service} not exists!`);
  }

  const credentials = grpc.credentials.createInsecure();

  const client = new Service(host, credentials, undefined);

  if (!client[method]) {
    throw new Error(`Method name: ${method} not exists!`);
  }

  const grpcCallReqMetadata = new Metadata();
  grpcCallReqMetadata.set("service-name", "sms-core");
  grpcCallReqMetadata.set("service-port", "9000");
  grpcCallReqMetadata.set("proxy-token", "cf5bbec01cdb988c6b43");

  return new Promise((resolve) => {
    try {
      client[method](
        request,
        grpcCallReqMetadata,
        { deadline: Date.now() + 10000 },
        (error: any, response: any, metadata: any) => {
          resolve({ error, response, metadata });
        }
      );
    } catch (error) {
      console.log("error :>> ", error);
    }
  });
});
