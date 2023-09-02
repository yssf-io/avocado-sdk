/* eslint-disable camelcase */
import { TransactionResponse, Provider, TransactionRequest } from '@ethersproject/abstract-provider'
import { Signer, TypedDataDomain, TypedDataField, TypedDataSigner } from '@ethersproject/abstract-signer'
import { Deferrable } from '@ethersproject/properties'
import { JsonRpcSigner, StaticJsonRpcProvider } from '@ethersproject/providers'
import { keccak256 } from '@ethersproject/solidity'
import { Bytes, hexlify } from "@ethersproject/bytes";
import { toUtf8Bytes } from "@ethersproject/strings";
import { BigNumber, Contract, constants, ethers, utils } from 'ethers'
import { avoContracts, AvoSafeVersion } from './contracts'
import { getRpcProvider } from './providers'
import { parse } from 'semver';
import { AVOCADO_CHAIN_ID } from './config'
import { signTypedData } from './utils/signTypedData'
import { AvoCoreStructs, AvoForwarder, IAvoWalletV1, IAvoWalletV2 } from './contracts/AvoForwarder'
import { AvoWalletV3__factory } from './contracts/factories'
import { AvoWalletV3 } from './contracts/AvoWalletV3'

export interface SignatureOption {
  /** generic additional metadata */
  metadata?: string;
  /** source address for referral system */
  source?: string;
  /** time in seconds until which the signature is valid and can be executed */
  validUntil?: string;
  /** time in seconds after which the signature is valid and can be executed */
  validAfter?: string;
  /** minimum amount of gas that the relayer (AvoForwarder) is expected to send along for successful execution */
  gas?: string;
  /** maximum gas price at which the signature is valid and can be executed. Not implemented yet. */
  gasPrice?: string;
  /** id for actions, e.g. 0 = CALL, 1 = MIXED (call and delegatecall), 20 = FLASHLOAN_CALL, 21 = FLASHLOAN_MIXED. 
   *  Default value of 0 will work for all most common use-cases. */
  id?: string;
  /** sequential avoSafeNonce as current value on the smart wallet contract or set to `-1`to use a non-sequential nonce. 
   *  Leave value as undefined to automatically use the next sequential nonce. */
  avoSafeNonce?: string | number;
  /** salt to customize non-sequential nonce (if `avoSafeNonce` is set to -1) */
  salt?: string;
  /** address of the Avocado smart wallet */
  safeAddress?: string;

  name?: string;
  version?: string;
}

export type RawTransaction = TransactionRequest & { operation?: string }

const typesV1 = {
  Cast: [
    { name: "actions", type: "Action[]" },
    { name: "validUntil", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "source", type: "address" },
    { name: "metadata", type: "bytes" },
    { name: "avoSafeNonce", type: "uint256" },
  ],
  Action: [
    { name: "target", type: "address" },
    { name: "data", type: "bytes" },
    { name: "value", type: "uint256" },
  ],
}

const typesV2 = {
  Cast: [
    { name: "actions", type: "Action[]" },
    { name: "params", type: "CastParams" },
    { name: "avoSafeNonce", type: "uint256" },
  ],
  Action: [
    { name: "target", type: "address" },
    { name: "data", type: "bytes" },
    { name: "value", type: "uint256" },
    { name: "operation", type: "uint256" },
  ],
  CastParams: [
    { name: "validUntil", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "source", type: "address" },
    { name: "id", type: "uint256" },
    { name: "metadata", type: "bytes" },
  ],
};

const typesMultisig = {
  Action: [
    { name: "target", type: "address" },
    { name: "data", type: "bytes" },
    { name: "value", type: "uint256" },
    { name: "operation", type: "uint256" },
  ],
  Cast: [
    { name: "params", type: "CastParams" },
    { name: "forwardParams", type: "CastForwardParams" },
  ],
  CastForwardParams: [
    { name: "gas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validUntil", type: "uint256" },
    { name: "value", type: "uint256" },
  ],
  CastParams: [
    { name: "actions", type: "Action[]" },
    { name: "id", type: "uint256" },
    { name: "avoNonce", type: "int256" },
    { name: "salt", type: "bytes32" },
    { name: "source", type: "address" },
    { name: "metadata", type: "bytes" },
  ],
};

class AvoSigner extends Signer implements TypedDataSigner {
  _avoWallet?: AvoWalletV3
  _polygonForwarder: AvoForwarder
  _avoProvider: StaticJsonRpcProvider
  private _chainId: Promise<number> | undefined
  public customChainId: number | undefined

  constructor(readonly signer: Signer, readonly provider = signer.provider) {
    super()
    this._polygonForwarder = avoContracts.forwarder(137)
    this._avoProvider = getRpcProvider(AVOCADO_CHAIN_ID)
  }

  async _signTypedData(domain: TypedDataDomain, types: Record<string, TypedDataField[]>, value: Record<string, any>): Promise<string> {
    if ("privateKey" in this.signer) {
      return await (this.signer as Signer as JsonRpcSigner)._signTypedData(
        domain,
        types,
        value
      );
    }

    const result = await signTypedData(this.signer.provider as any,
      await this.getOwnerAddress(),
      {
        domain,
        types,
        value
      })

    if (!result.signature) {
      throw Error("Failed to get signature");
    }

    return result.signature
  }

  async syncAccount(options?: Pick<SignatureOption, 'safeAddress'>): Promise<void> {
    if (!this._avoWallet) {
      const owner = await this.getOwnerAddress()
      const safeAddress = options?.safeAddress || await this._polygonForwarder.computeAddress(owner)

      this._avoWallet = AvoWalletV3__factory.connect(safeAddress, this.signer)
    }

    if (this.provider) { this._chainId = this.provider.getNetwork().then(net => net.chainId) }
  }

  async getAvoWallet(targetChainId: number) {
    const owner = await this.getOwnerAddress()
    const safeAddress = await this._polygonForwarder.computeAddress(owner)
    return AvoWalletV3__factory.connect(safeAddress, getRpcProvider(targetChainId))
  }

  async getAddress(): Promise<string> {
    await this.syncAccount()
    return this._avoWallet!.address
  }

  async getAddressMultisig(index: number): Promise<string> {
    const avoForwarder = new Contract(
      "0x46978CD477A496028A18c02F07ab7F35EDBa5A54",
      new utils.Interface([
        "function computeAvocado(address owner, uint32 index) view external returns(address)",
      ]),
      getRpcProvider(137)
    );
    return await avoForwarder.computeAvocado(await this.getOwnerAddress(), index)
  }

  async getOwnerAddress(): Promise<string> {
    return await this.signer.getAddress()
  }

  async getSafeNonce(chainId: number): Promise<string> {
    const forwarder = avoContracts.forwarder(chainId)

    const owner = await this.getOwnerAddress()

    const avoSafeNonce = await forwarder.avoSafeNonce(owner).then(String)

    return avoSafeNonce
  }

  async getSafeNonceMultisig(chainId: number, index: number): Promise<string> {
    const owner = await this.getOwnerAddress()

    const avoForwarder = new Contract(
      "0x46978CD477A496028A18c02F07ab7F35EDBa5A54",
      new utils.Interface([
        "function avoNonce(address owner, uint32 index) view external returns(uint256)",
      ]),
      getRpcProvider(chainId)
    );

    const avoSafeNonce = await avoForwarder.avoNonce(owner, index).then(String);

    return avoSafeNonce
  }

  async generateSignatureMessage(transactions: Deferrable<RawTransaction>[], targetChainId: number, options?: SignatureOption) {
    await this.syncAccount(options)

    const avoSafeNonce = options && typeof options.avoSafeNonce !== 'undefined' ? String(options.avoSafeNonce) : await this.getSafeNonce(targetChainId)

    const avoVersion = options?.version
      ? (parse(options.version)?.major || 1) === 1
        ? AvoSafeVersion.V1
        : AvoSafeVersion.V2
      : await avoContracts.safeVersion(targetChainId, options?.safeAddress || await this.getAddress());

    if (avoVersion === AvoSafeVersion.V2) {
      return {
        actions: transactions.map(transaction => (
          {
            operation: transaction.operation || "0",
            target: transaction.to,
            data: transaction.data || '0x',
            value: transaction.value ? transaction.value.toString() : '0'
          }
        )),
        params: {
          metadata: options && options.metadata ? options.metadata : '0x',
          source: options && options.source ? options.source : '0x000000000000000000000000000000000000Cad0',
          id: options && options.id ? options.id : '0',
          validUntil: options && options.validUntil ? options.validUntil : '0',
          gas: options && options.gas ? options.gas : '0',
        },
        avoSafeNonce,
      }
    }

    return {
      actions: transactions.map(transaction => (
        {
          target: transaction.to,
          data: transaction.data || '0x',
          value: transaction.value ? transaction.value.toString() : '0'
        }
      )),
      metadata: options && options.metadata ? options.metadata : '0x',
      source: options && options.source ? options.source : '0x000000000000000000000000000000000000Cad0',
      avoSafeNonce,
      validUntil: options && options.validUntil ? options.validUntil : '0',
      // gas: transactions.reduce((acc, curr) => {
      //   return acc.add(curr.gasLimit ? curr.gasLimit.toString() : '8000000')
      // }, BigNumber.from(0)).toString(),
      gas: options && options.gas ? options.gas : '0',
    }
  }

  async generateSignatureMessageMultisig(transactions: Deferrable<RawTransaction>[], targetChainId: number, index: number, options?: SignatureOption) {
    await this.syncAccount(options)

    const avoNonce = options && typeof options.avoSafeNonce !== 'undefined' ? String(options.avoSafeNonce) : await this.getSafeNonceMultisig(targetChainId, index)

    return {
      params: {
        actions: transactions.map((transaction) => {
          return {
            operation: transaction.operation || "0",
            target: transaction.to,
            data: transaction.data || "0x",
            value: transaction.value ? transaction.value.toString() : "0",
          };
        }),
        id: "0",
        avoNonce,
        salt: constants.HashZero, // TODO: compute salt
        source: "0xE8385fB3A5F15dED06EB5E20E5A81BF43115eb8E", // is this right?
        metadata: "0x00", // TODO: compute metadata
      },
      forwardParams: {
        gas: "0",
        gasPrice: "0",
        validUntil: "0",
        validAfter: "0",
        value: "0",
      },
    };
  }

  async sendTransaction(transaction: Deferrable<RawTransaction>, options?: SignatureOption): Promise<TransactionResponse> {
    return await this.sendTransactions([transaction], await transaction.chainId, options);
  }

  async sendTransactions(transactions: Deferrable<RawTransaction>[], targetChainId?: Deferrable<number>, options?: SignatureOption): Promise<TransactionResponse> {
    await this.syncAccount(options)

    if (await this._chainId !== AVOCADO_CHAIN_ID) {
      throw new Error(`Signer provider chain id should be ${AVOCADO_CHAIN_ID}`)
    }

    const chainId: number | undefined = this.customChainId || (await targetChainId)

    if (!chainId) {
      throw new Error('Chain ID is required')
    }

    const message = await this.generateSignatureMessage(
      transactions,
      chainId,
      options
    );

    const signature = await this.buildSignature({
      message,
      chainId,
    }, options)

    return this.broadcastSignedMessage({ message, chainId, signature, safeAddress: options?.safeAddress });
  }

  async sendTransactionsMultisig(transactions: Deferrable<RawTransaction>[], index: number, targetChainId?: Deferrable<number>, options?: SignatureOption): Promise<TransactionResponse> {
    await this.syncAccount(options)

    if (await this._chainId !== AVOCADO_CHAIN_ID) {
      throw new Error(`Signer provider chain id should be ${AVOCADO_CHAIN_ID}`)
    }

    const chainId: number | undefined = this.customChainId || (await targetChainId)

    if (!chainId) {
      throw new Error('Chain ID is required')
    }

    const message = await this.generateSignatureMessageMultisig(
      transactions,
      chainId,
      index,
      options
    );

    const signature = await this.buildSignatureMultisig({
      message,
      chainId,
      index
    }, options)

    return this.broadcastSignedMessageMultisig({ message, chainId, signature, index });
  }

  async broadcastSignedMessage({ message, chainId, signature, safeAddress, name, version }: { message: any, chainId: number, signature: string, safeAddress?: string, name?: string, version?: string }) {
    const owner = await this.getOwnerAddress()

    let digestHash
    {

      if (!name || !version) {
        const forwarder = avoContracts.forwarder(chainId)
        let targetChainAvoWallet = await this.getAvoWallet(chainId);

        try {
          version = await targetChainAvoWallet.DOMAIN_SEPARATOR_VERSION()
          name = await targetChainAvoWallet.DOMAIN_SEPARATOR_NAME()
        } catch (error) {
          version = await forwarder.avoWalletVersion('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')
          name = await forwarder.avoWalletVersionName('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')
        }
      }

      const versionMajor = parse(version)?.major || 1;

      // Creating domain for signing using Avocado wallet address as the verifying contract
      const domain = {
        name,
        version,
        chainId: String(AVOCADO_CHAIN_ID),
        salt: keccak256(['uint256'], [chainId]),
        verifyingContract: safeAddress || await this.getAddress()
      }

      // The named list of all type definitions
      const types = {
        1: typesV1,
        2: typesV2,
      }[versionMajor] || {}

      // Adding values for types mentioned
      const value = message

      digestHash = ethers.utils._TypedDataEncoder.hash(domain, types, value)
    }

    const transactionHash = await this._avoProvider.send('txn_broadcast', [
      {
        signature,
        message,
        owner,
        targetChainId: String(chainId),
        dryRun: false,
        safe: safeAddress || await this.getAddress(),
        digestHash
      }
    ])

    if (transactionHash === '0x') {
      throw new Error('Tx failed!')
    }

    await new Promise(resolve => setTimeout(resolve, 2000))

    let tx = await getRpcProvider(chainId).getTransaction(transactionHash)

    if (!tx) {
      tx = await new Promise(resolve => setTimeout(resolve, 2000))
    }

    if (!tx) {
      tx = await new Promise(resolve => setTimeout(resolve, 2000))
    }

    if (tx) {
      return tx
    }

    return {
      from: owner,
      nonce: 0,
      confirmations: 0,
      chainId,
      data: '0x',
      gasLimit: BigNumber.from(0),
      value: BigNumber.from(0),
      hash: transactionHash,
      wait: async (confirmations?: number) => {
        return await getRpcProvider(chainId).waitForTransaction(transactionHash, confirmations || 0)
      }
    }
  }

  async broadcastSignedMessageMultisig({ message, chainId, signature, index }: { message: any, chainId: number, signature: string, index: number }) {
    const owner = await this.getOwnerAddress()

    const transactionHash = await this._avoProvider.send('txn_broadcast', [
      {
        signatures: [
          {
            signature,
            signer: await this.getOwnerAddress(),
          },
        ],
        message,
        owner: await this.getOwnerAddress(),
        safe: await this.getAddressMultisig(index),
        targetChainId: String(chainId),
        index: "0",
      },
    ])

    if (transactionHash === '0x') {
      throw new Error('Tx failed!')
    }

    await new Promise(resolve => setTimeout(resolve, 2000))

    let tx = await getRpcProvider(chainId).getTransaction(transactionHash)

    if (!tx) {
      tx = await new Promise(resolve => setTimeout(resolve, 2000))
    }

    if (!tx) {
      tx = await new Promise(resolve => setTimeout(resolve, 2000))
    }

    if (tx) {
      return tx
    }

    return {
      from: owner,
      nonce: 0,
      confirmations: 0,
      chainId,
      data: '0x',
      gasLimit: BigNumber.from(0),
      value: BigNumber.from(0),
      hash: transactionHash,
      wait: async (confirmations?: number) => {
        return await getRpcProvider(chainId).waitForTransaction(transactionHash, confirmations || 0)
      }
    }
  }

  async verify({ message, chainId, signature, safeAddress }: { message: any, chainId: number, signature: string, safeAddress?: string }) {
    const forwarder = avoContracts.forwarder(chainId)

    // get avocado wallet version
    const avoVersion = await avoContracts.safeVersion(chainId, safeAddress || await this.getAddress());

    // get owner of `safeAddress` for from param
    const safeOwner = await avoContracts.safeV3(safeAddress || await this.getAddress(), this.signer).owner();

    // note verify methods are expected to be called via .callStatic because otherwise they potentially
    // would deploy the wallet if it is not deployed yet 
    if (avoVersion === AvoSafeVersion.V3) {
      return forwarder.callStatic.verifyV3(
        safeOwner,
        message.params as AvoCoreStructs.CastParamsStruct,
        message.forwarderParams as AvoCoreStructs.CastForwardParamsStruct,
        {
          signature,
          signer: constants.AddressZero // will need to change this to support smart contract signatures
        }
      )
    }

    if (avoVersion === AvoSafeVersion.V2) {
      return forwarder.callStatic.verifyV2(
        safeOwner,
        message.actions as IAvoWalletV2.ActionStruct[],
        message.params as IAvoWalletV2.CastParamsStruct,
        signature
      )
    }

    return forwarder.callStatic.verifyV1(
      safeOwner,
      message.actions as IAvoWalletV1.ActionStruct[],
      message.validUntil,
      message.gas,
      message.source,
      message.metadata,
      signature
    )
  }

  async signMessage(message: Bytes | string): Promise<string> {
    const data = ((typeof (message) === "string") ? toUtf8Bytes(message) : message);

    const address = await this.getOwnerAddress();

    return await (this.provider as any).send("personal_sign", [hexlify(data), address.toLowerCase()]);
  }

  signTransaction(_transaction: any): Promise<string> {
    throw new Error('Method not implemented.')
  }

  connect(_provider: Provider): Signer {
    return this
  }

  async buildSignature({ message, chainId }: { message: any, chainId: number }, options?: SignatureOption) {
    await this.syncAccount(options)

    const forwarder = avoContracts.forwarder(chainId)
    let targetChainAvoWallet = await this.getAvoWallet(chainId);

    let name = options?.name
    let version = options?.version

    if (!name || !version) {
      try {
        version = await targetChainAvoWallet.DOMAIN_SEPARATOR_VERSION()
        name = await targetChainAvoWallet.DOMAIN_SEPARATOR_NAME()
      } catch (error) {
        version = await forwarder.avoWalletVersion('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')
        name = await forwarder.avoWalletVersionName('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')
      }
    }

    const versionMajor = parse(version)?.major || 1;

    // Creating domain for signing using Avocado wallet address as the verifying contract
    const domain = {
      name,
      version,
      chainId: String(AVOCADO_CHAIN_ID),
      salt: keccak256(['uint256'], [chainId]),
      verifyingContract: options?.safeAddress || await this.getAddress()
    }

    // The named list of all type definitions
    const types = {
      1: typesV1,
      2: typesV2,
    }[versionMajor] || {}

    // Adding values for types mentioned
    const value = message

    return await this._signTypedData(domain, types, value)
  }

  async buildSignatureMultisig({ message, chainId, index }: { message: any, chainId: number, index: number }, options?: SignatureOption) {
    await this.syncAccount(options)

    const owner = await this.getOwnerAddress()

    const avoForwarder = new Contract(
      "0x46978CD477A496028A18c02F07ab7F35EDBa5A54",
      new utils.Interface([
        "function avocadoVersion(address owner, uint32 index) view external returns(string)",
        "function avocadoVersionName(address owner, uint32 index) view external returns(string)",
      ]),
      getRpcProvider(chainId)
    );

    let name = options?.name
    let version = options?.version

    if (!name || !version) {
      version = await avoForwarder.avocadoVersion(owner, index)
      name = await avoForwarder.avocadoVersionName(owner, index)
    }

    // Creating domain for signing using Avocado wallet address as the verifying contract
    const domain = {
      name,
      version,
      chainId: String(AVOCADO_CHAIN_ID),
      salt: keccak256(['uint256'], [chainId]),
      verifyingContract: options?.safeAddress || await this.getAddressMultisig(index)
    }

    // The named list of all type definitions
    const types = typesMultisig;

    // Adding values for types mentioned
    const value = message

    return await this._signTypedData(domain, types, value)
  }
}

export function createSafe(signer: Signer, provider = signer.provider) {
  if (!provider) {
    throw new Error('Provider')
  }

  const avoSigner = new AvoSigner(
    signer,
    provider
  )

  return {
    /**
     * Get the current AvoSigner
     * 
     * @returns current AvoSigner instance
     */
    getSigner() {
      return avoSigner
    },

    /**
     * Generates the signature message for a set of `transactions` with the respective `options`. 
     * This can be subsequently used as input for {@link buildSignature} or also be used in direct interaction
     * with contracts to access methods not covered by the Avocado SDK itself.
     *
     * @param transactions - Transactions to be executed in the Avocado smart wallet. 
     * @param targetChainId - The chain id of the network where the transactions will be executable
     * @param options - Optional options to specify things such as time limiting validity, using a non-sequential nonce etc.
     * @returns Object that can be fed into {@link buildSignature} or directly used for contract interaction
     */
    async generateSignatureMessage(transactions: Deferrable<RawTransaction>[], targetChainId: number, options?: SignatureOption) {
      return await avoSigner.generateSignatureMessage(transactions, targetChainId, options)
    },

    /**
     * Builds a valid signature from the returned value of {@link generateSignatureMessage}. 
     * The returned signature can be used to execute the actions at the Avocado smart wallet.
     * This will automatically trigger the user to sign the message.
     *
     * @param message - The previously generated message with {@link generateSignatureMessage}. 
     * @param chainId - The chain id of the network where this signed transaction will be executable
     * @returns A signed, executable message for an Avocado smart wallet
     */
    async buildSignature(message: Awaited<ReturnType<typeof avoSigner.generateSignatureMessage>>, chainId: number) {
      return await avoSigner.buildSignature({
        message,
        chainId
      })
    },

    /**
     * Executes multiple `transactions` with the Avocado smart wallet,automatically triggering the user to sign the message for execution.
     *
     * @param transactions - Transactions to be executed in the Avocado smart wallet. 
     * @param targetChainId - The chain id of the network where the transactions will be executed
     * @param options - Optional options to specify things such as using a non-sequential nonce etc.
     * @returns the TransactionResponse result
     */
    async sendTransactions(transactions: Deferrable<RawTransaction>[], targetChainId: number, options?: SignatureOption): Promise<TransactionResponse> {
      return await avoSigner.sendTransactions(transactions, targetChainId, options)
    },

    /**
     * Executes a `transaction` with the Avocado smart wallet, automatically triggering the user to sign the message for execution.
     *
     * @param transaction - Transaction to be executed in the Avocado smart wallet. 
     * @param targetChainId - The chain id of the network where the transactions will be executed
     * @param options - Optional options to specify things such as using a non-sequential nonce etc.
     * @returns the TransactionResponse result
     */
    async sendTransaction(transaction: Deferrable<RawTransaction>, targetChainId?: number, options?: SignatureOption): Promise<TransactionResponse> {
      return await avoSigner.sendTransaction({
        ...transaction,
        chainId: targetChainId || await transaction.chainId
      }, options)
    },

    /**
     * Broadcasts a previously signed message with valid signature.
     *
     * @param message - The previously generated message with {@link generateSignatureMessage}. 
     * @param signature - The user signature for the message with {@link buildSignature}. 
     * @param chainId - The chain id of the network where this signed transaction will be executable
     * @param safeAddress - Optional address of the smart wallet in case it is not the one for the current signer
     * @returns the TransactionResponse result
     */
    async broadcastSignedMessage(message: Awaited<ReturnType<typeof avoSigner.generateSignatureMessage>>, signature: string, chainId: number, safeAddress?: string): Promise<TransactionResponse> {
      return await avoSigner.broadcastSignedMessage({ message, signature, chainId, safeAddress })
    },

    /**
     * Verifies the validity of a signature for a previously signed message.
     *
     * @param message - The previously generated message with {@link generateSignatureMessage}. 
     * @param signature - The user signature for the message with {@link buildSignature}. 
     * @param chainId - The chain id of the network where this signed transaction will be executable
     * @param safeAddress - Optional address of the smart wallet in case it is not the one for the current signer
     * @returns the TransactionResponse result
     */
    async verify(message: Awaited<ReturnType<typeof avoSigner.generateSignatureMessage>>, signature: string, chainId: number, safeAddress?: string): Promise<boolean> {
      return await avoSigner.verify({ message, signature, chainId, safeAddress })
    },

    async estimateFee(transactions: Deferrable<RawTransaction>[], targetChainId: number, options?: SignatureOption): Promise<{
      fee: string,
      multiplier: string,
      discount?: { amount: string, program: string, name: string, description: string }
    }> {
      const message = await avoSigner.generateSignatureMessage(transactions, targetChainId, options)

      const response = await avoSigner._avoProvider.send('txn_estimateFeeWithoutSignature', [
        message,
        await signer.getAddress(),
        targetChainId,
      ])

      return {
        ...response,
        fee: BigNumber.from(response.fee).toString(),
        multiplier: BigNumber.from(response.multiplier).toString(),
      }
    },

    /**
     * Get the current AvoSigner instance for a different chain id
     * 
     * @param chainId - The chain id of the network
     * @returns AvoSigner for the respective `chainId`
     */
    getSignerForChainId(chainId: number | string) {
      return new Proxy(avoSigner, {
        get(target, p, receiver) {
          if (p === 'customChainId') {
            return Number(chainId)
          }

          return Reflect.get(target, p, receiver)
        }
      })
    },

    /**
     * Get the owner address of the current AvoSigner instance
     * 
     * @returns current AvoSigner instance owner's address
     */
    async getOwnerAddress() {
      return await avoSigner.getOwnerAddress()
    },

    /**
     * Get the safe address of the current AvoSigner instance
     * 
     * @returns current avoSigner instance address
     */
    async getSafeAddress() {
      return await avoSigner.getAddress()
    },

    /**
     * Get the current avoSafeNonce value at the smart wallet
     * 
     * @param chainId - The chain id of the network
     * @returns current avoSafeNonce value
     */
    async getSafeNonce(chainId: number | string) {
      return await avoSigner.getSafeNonce(Number(chainId))
    },
  }
}
