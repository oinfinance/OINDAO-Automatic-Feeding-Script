import Web3 from "web3";
import Axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import httpsProxyAgent from "https-proxy-agent";
import { BigNumber } from "bignumber.js";
import dotenv from "dotenv";
import ORACLE_ABI from "./src/abi/oracle.json";
import { Transaction as Tx } from "ethereumjs-tx";

declare module "axios" {
  interface AxiosInstance {
    get<T = any>(url: string, config?: AxiosRequestConfig): Promise<T>;
  }
}

interface BitmaxResData {
  code: number;
  data: {
    symbol: string;
    open: string;
    close: string;
    high: string;
    low: string;
    volume: string;
    ask: [string, string];
    bid: [string, string];
    type: string;
  };
}

interface GateioResData {
  result: string;
  last: string;
  lowestAsk: string;
  highestBid: string;
  percentChange: string;
  baseVolume: string;
  quoteVolume: string;
  high24hr: string;
  low24hr: string;
}

dotenv.config();

let recordPrice: BigNumber = new BigNumber("0");
const time = 60000;
const web3 = new Web3(
  `https://${process.env.NETWORK}.infura.io/v3/${process.env.INFURA_KEY}`,
);
const oracle = new web3.eth.Contract(
  ORACLE_ABI as any,
  process.env.ORACLE_ADDRESS,
);

const sendTx = async (
  data: string,
  from: string = process.env.WALLET_ADDRESS as string,
  to: string,
) => {
  const gasLimit: string = web3.utils.toHex("100000");
  const gasPrice: string = web3.utils.toHex(
    new BigNumber(Number(await web3.eth.getGasPrice()) * 1.06).toFixed(0),
  );
  const nonce: string = web3.utils.toHex(
    await web3.eth.getTransactionCount(from),
  );
  const privateKey: Buffer = Buffer.from(
    process.env.PRIVATE_KEY as string,
    "hex",
  );

  const rawTx = {
    nonce,
    to,
    value: 0,
    gasPrice,
    gasLimit,
    data,
  };

  const tx: Tx = new Tx(rawTx, { chain: process.env.NETWORK });
  tx.sign(privateKey);

  const serializedTx = "0x" + tx.serialize().toString("hex");

  return new Promise((resolve, reject) => {
    web3.eth
      .sendSignedTransaction(serializedTx, (err, hash) => {
        console.log("交易hash: " + hash);
      })
      .then(resolve)
      .catch(reject);
  });
};

const axios: AxiosInstance = Axios.create({
  timeout: 30000 /*  30s  */,
  // proxy: false,
  //   @ts-ignore
  // httpsAgent: new httpsProxyAgent("http://127.0.0.1:1088"),
});

axios.interceptors.response.use((res: AxiosResponse) => {
  return res.status === 200 ? res.data : res;
});

const priceUrls: string[] = [
  "https://bitmax.io/api/pro/v1/ticker?symbol=FRONT/USDT",
  "https://data.gateio.la/api2/1/ticker/front_usdt",
];

const getPrice = async (): Promise<BigNumber> => {
  const [bitmax, gateio] = (await Promise.all(
    priceUrls.map((url) => axios.get(url)),
  )) as [BitmaxResData, GateioResData];
  const results: string[][] = [
    [bitmax.data.close, bitmax.data.volume],
    [gateio.last, gateio.baseVolume],
  ];
  const resultb: BigNumber[][] = results.map((x) =>
    x.map((y) => new BigNumber(y)),
  );
  const product: BigNumber[] = resultb.map(([a, b]) => a.multipliedBy(b));
  const sum: BigNumber = product.reduce((a, b) => a.plus(b));

  const result: BigNumber = results.reduce((a, b, index) => {
    return a.plus(
      resultb[index][0].multipliedBy(product[index]).dividedBy(sum),
    );
  }, new BigNumber(0));

  return result;
};

const poke = async (): Promise<void> => {
  console.log("================== POKE START ==================");
  try {
    const start = Date.now();
    const price = new BigNumber(
      (await getPrice()).multipliedBy(10 ** 5).toFixed(0),
    ).multipliedBy(10 ** 13);
    console.log(
      `price get success: ${price.toString()} Get time duration: ${
        Date.now() - start
      }ms`,
    );
    //   @ts-ignore 
    const result = recordPrice.eq(0)
      ? new BigNumber(0.1)
      : recordPrice.minus(price).dividedBy(recordPrice);

    if (
      price.gte(new BigNumber(4000000)) &&
      (result.gte(new BigNumber(0.1)) || result.lte(new BigNumber(-0.1)))
    ) {
      const s1 = Date.now();
      await sendTx(
        oracle.methods.poke(price.toString()).encodeABI(),
        undefined,
        process.env.ORACLE_ADDRESS as string,
      );
      //   TODO 触发一次钉钉提醒
      console.log(
        `Duration: ${
          Date.now() - s1
        }ms Time: ${Date.now()} price from ${recordPrice.toString()} to ${price.toString()}`,
      );
      recordPrice = price;
    }

    setTimeout(poke, time);
  } catch (e) {
    console.log("喂价失败: " + e);
    //   TODO 触发钉钉提醒
    return poke();
  } finally {
    console.log("================== POKE END ==================");
  }
};

poke();
