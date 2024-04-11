const { artifacts, contract, ethers } = require('hardhat')
const { ZERO_ADDRESS, MAX_UINT256 } = require('../helpers/constants')

const { ETH, toBN } = require('../helpers/utils')
const withdrawals = require('../helpers/withdrawals')
const { assert } = require('../helpers/assert')
const { DEFAULT_DEPLOY_PARAMS, DEFAULT_FACTORIES } = require('../helpers/config')
const { newDao } = require('../helpers/dao')
const { updateLocatorImplementation } = require('../helpers/locator-deploy')
const { addStakingModules } = require('../helpers/protocol')

const StETHMock = artifacts.require('StETHPermitMock.sol')
const WstETH = artifacts.require('WstETHMock.sol')
const EIP712StETH = artifacts.require('EIP712StETH')
const NFTDescriptorMock = artifacts.require('NFTDescriptorMock.sol')

const QUEUE_NAME = 'Unsteth nft'
const QUEUE_SYMBOL = 'UNSTETH'
const NFT_DESCRIPTOR_BASE_URI = 'https://exampleDescriptor.com'

async function deployWithdrawalQueue({
  stethOwner,
  queueAdmin,
  queuePauser,
  queueResumer,
  queueFinalizer,
  queueOracle,
  queueName = QUEUE_NAME,
  symbol = QUEUE_SYMBOL,
  doResume = true,
}) {
  const protocol = {}
  protocol.deployParams = { ...DEFAULT_DEPLOY_PARAMS }
  protocol.factories = { ...DEFAULT_FACTORIES }

  // accounts
  protocol.signers = await ethers.getSigners()
  protocol.appManager = await protocol.factories.appManagerFactory(protocol)
  protocol.treasury = await protocol.factories.treasuryFactory(protocol)
  protocol.voting = await protocol.factories.votingFactory(protocol)
  protocol.guardians = await protocol.factories.guardiansFactory(protocol)

  const { dao, acl } = await newDao(protocol.appManager.address)
  protocol.dao = dao
  protocol.acl = acl

  protocol.pool = await protocol.factories.lidoFactory(protocol)
  protocol.token = protocol.pool
  protocol.wsteth = await protocol.factories.wstethFactory(protocol)

  protocol.legacyOracle = await protocol.factories.legacyOracleFactory(protocol)

  protocol.depositContract = await protocol.factories.depositContractFactory(protocol)

  protocol.burner = await protocol.factories.burnerFactory(protocol)
  protocol.lidoLocator = await protocol.factories.lidoLocatorFactory(protocol)

  await updateLocatorImplementation(protocol.lidoLocator.address, protocol.appManager.address, {
    lido: protocol.pool.address,
    burner: protocol.burner.address,
  })

  protocol.validatorExitBus = await protocol.factories.validatorExitBusFactory(protocol)
  protocol.oracleReportSanityChecker = await protocol.factories.oracleReportSanityCheckerFactory(protocol)
  protocol.oracle = await protocol.factories.accountingOracleFactory(protocol)

  protocol.withdrawalCredentials = await protocol.factories.withdrawalCredentialsFactory(protocol)
  protocol.stakingRouter = await protocol.factories.stakingRouterFactory(protocol)
  protocol.stakingModules = await addStakingModules(protocol.factories.stakingModulesFactory, protocol)
  protocol.depositSecurityModule = await protocol.factories.depositSecurityModuleFactory(protocol)

  protocol.elRewardsVault = await protocol.factories.elRewardsVaultFactory(protocol)
  protocol.withdrawalVault = await protocol.factories.withdrawalVaultFactory(protocol)
  protocol.eip712StETH = await protocol.factories.eip712StETHFactory(protocol)

  await updateLocatorImplementation(protocol.lidoLocator.address, protocol.appManager.address, {
    depositSecurityModule: protocol.depositSecurityModule.address,
    elRewardsVault: protocol.elRewardsVault.address,
    legacyOracle: protocol.legacyOracle.address,
    stakingRouter: protocol.stakingRouter.address,
    treasury: protocol.treasury.address,
    withdrawalVault: protocol.withdrawalVault.address,
    postTokenRebaseReceiver: protocol.legacyOracle.address,
    accountingOracle: protocol.oracle.address,
    oracleReportSanityChecker: protocol.oracleReportSanityChecker.address,
    validatorsExitBusOracle: protocol.validatorExitBus.address,
  })

  await protocol.pool.initialize(protocol.lidoLocator.address, protocol.eip712StETH.address, { value: ETH(1) })

  const nftDescriptor = await NFTDescriptorMock.new(NFT_DESCRIPTOR_BASE_URI)
  const steth = await StETHMock.new({ value: ETH(1), from: stethOwner })
  const wsteth = await WstETH.new(steth.address, { from: stethOwner })
  const eip712StETH = await EIP712StETH.new(steth.address, { from: stethOwner })
  await steth.initializeEIP712StETH(eip712StETH.address)

  const { queue: withdrawalQueue, impl: withdrawalQueueImplementation } = await withdrawals.deploy(
    queueAdmin,
    wsteth.address,
    protocol.pool.address,
    queueName,
    symbol
  )

  const initTx = await withdrawalQueue.initialize(queueAdmin)

  await withdrawalQueue.grantRole(await withdrawalQueue.FINALIZE_ROLE(), queueFinalizer || steth.address, {
    from: queueAdmin,
  })
  await withdrawalQueue.grantRole(await withdrawalQueue.PAUSE_ROLE(), queuePauser || queueAdmin, { from: queueAdmin })
  await withdrawalQueue.grantRole(await withdrawalQueue.RESUME_ROLE(), queueResumer || queueAdmin, { from: queueAdmin })
  await withdrawalQueue.grantRole(await withdrawalQueue.ORACLE_ROLE(), queueOracle || steth.address, {
    from: queueAdmin,
  })

  return {
    initTx,
    steth,
    wsteth,
    withdrawalQueue,
    nftDescriptor,
    withdrawalQueueImplementation,
  }
}

module.exports = {
  deployWithdrawalQueue,
  QUEUE_NAME,
  QUEUE_SYMBOL,
  NFT_DESCRIPTOR_BASE_URI,
}

contract(
  'WithdrawalQueue',
  ([stethOwner, queueAdmin, queuePauser, queueResumer, queueFinalizer, queueBunkerReporter]) => {
    context('initialization', () => {
      it('bunker mode is disabled by default', async () => {
        const { withdrawalQueue } = await deployWithdrawalQueue({
          stethOwner,
          queueAdmin,
          queuePauser,
          queueResumer,
        })
        const BUNKER_MODE_DISABLED_TIMESTAMP = await withdrawalQueue.BUNKER_MODE_DISABLED_TIMESTAMP()
        const isBunkerModeActive = await withdrawalQueue.isBunkerModeActive()
        const bunkerModeSinceTimestamp = await withdrawalQueue.bunkerModeSinceTimestamp()

        assert.equals(isBunkerModeActive, false)
        assert.equals(+bunkerModeSinceTimestamp, +BUNKER_MODE_DISABLED_TIMESTAMP)
      })

      it('emits InitializedV1', async () => {
        const { initTx } = await deployWithdrawalQueue({
          stethOwner,
          queueAdmin,
          queuePauser,
          queueResumer,
          queueFinalizer,
          queueBunkerReporter,
        })
        assert.emits(initTx, 'InitializedV1', {
          _admin: queueAdmin,
        })
      })

      it('initial queue and checkpoint items', async () => {
        const { withdrawalQueue } = await deployWithdrawalQueue({
          stethOwner,
          queueAdmin,
          queuePauser,
          queueResumer,
        })

        const queueId = await withdrawalQueue.getLastRequestId()
        const queueItem = await withdrawalQueue.getQueueItem(queueId)

        const checkpointIndex = await withdrawalQueue.getLastCheckpointIndex()
        const checkpointItem = await withdrawalQueue.getCheckpointItem(checkpointIndex)

        assert.equals(queueItem.cumulativeStETH, 0)
        assert.equals(queueItem.cumulativeShares, 0)
        assert.equals(queueItem.owner, ZERO_ADDRESS)
        assert.equals(queueItem.claimed, true)

        assert.equals(checkpointItem.fromRequestId, 0)
        assert.equals(checkpointItem.maxShareRate, 0)
      })

      it('check if pauser is zero', async () => {
        await assert.reverts(
          deployWithdrawalQueue({
            stethOwner,
            queueAdmin,
            queueName: '',
          }),
          'ZeroMetadata()'
        )
        await assert.reverts(
          deployWithdrawalQueue({
            stethOwner,
            queueAdmin,
            symbol: '',
          }),
          'ZeroMetadata()'
        )
      })

      it('implementation is petrified', async () => {
        const { withdrawalQueueImplementation } = await deployWithdrawalQueue({
          stethOwner,
          queueAdmin,
          queuePauser,
          queueResumer,
          doResume: false,
        })

        assert.equals(await withdrawalQueueImplementation.getContractVersion(), toBN(MAX_UINT256))

        await assert.reverts(withdrawalQueueImplementation.initialize(queueAdmin), 'NonZeroContractVersionOnInit()')
      })
    })
  }
)
