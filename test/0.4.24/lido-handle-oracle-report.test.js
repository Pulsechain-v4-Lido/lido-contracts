const { artifacts, contract, ethers } = require('hardhat')

const { assert } = require('../helpers/assert')
const {
  shareRate,
  ETH,
  toBN,
  genKeys,
  StETH,
  calcSharesMintedAsFees,
  limitRebase,
  addSendWithResult,
} = require('../helpers/utils')
const { deployProtocol } = require('../helpers/protocol')
const {
  EvmSnapshot,
  setBalance,
  advanceChainTime,
  getCurrentBlockTimestamp,
  getBalance,
} = require('../helpers/blockchain')
const { ZERO_ADDRESS, INITIAL_HOLDER } = require('../helpers/constants')
const { setupNodeOperatorsRegistry } = require('../helpers/staking-modules')
const { bn } = require('@aragon/contract-helpers-test/src/numbers')
const Lido = artifacts.require('Lido')

const ONE_YEAR = 3600 * 24 * 365
const ONE_DAY = 3600 * 24
const ORACLE_REPORT_LIMITS_BOILERPLATE = {
  churnValidatorsPerDayLimit: 255,
  oneOffCLBalanceDecreaseBPLimit: 100,
  annualBalanceIncreaseBPLimit: 10000,
  simulatedShareRateDeviationBPLimit: 15,
  maxValidatorExitRequestsPerReport: 10000,
  maxAccountingExtraDataListItemsCount: 10000,
  maxNodeOperatorsPerExtraDataItemCount: 10000,
  requestTimestampMargin: 24,
  maxPositiveTokenRebase: 1000000000,
}

const DEFAULT_LIDO_ORACLE_REPORT = {
  reportTimestamp: 0, // uint256, seconds
  timeElapsed: 0, // uint256, seconds
  clValidators: 0, // uint256, counter
  postCLBalance: ETH(0), // uint256, wei
  withdrawalVaultBalance: ETH(0), // uint256, wei
  elRewardsVaultBalance: ETH(0), // uint256, wei
  sharesRequestedToBurn: StETH(0), // uint256, wad
  withdrawalFinalizationBatches: [], // uint256, index
  simulatedShareRate: shareRate(0), // uint256, 10e27
}

const checkEvents = async ({
  tx,
  reportTimestamp = 0,
  preCLValidators,
  postCLValidators,
  preCLBalance,
  postCLBalance,
  withdrawalsWithdrawn,
  executionLayerRewardsWithdrawn,
  postBufferedEther,
  timeElapsed,
  preTotalShares,
  preTotalEther,
  postTotalShares,
  postTotalEther,
  sharesMintedAsFees,
}) => {
  assert.emits(
    tx,
    'CLValidatorsUpdated',
    {
      reportTimestamp: 0,
      preCLValidators,
      postCLValidators,
    },
    {
      abi: Lido.abi,
    }
  )
  assert.emits(
    tx,
    'ETHDistributed',
    {
      reportTimestamp,
      preCLBalance,
      postCLBalance,
      withdrawalsWithdrawn,
      executionLayerRewardsWithdrawn,
      postBufferedEther,
    },
    {
      abi: Lido.abi,
    }
  )
  assert.emits(
    tx,
    'TokenRebased',
    {
      reportTimestamp,
      timeElapsed,
      preTotalShares,
      preTotalEther,
      postTotalShares,
      postTotalEther,
      sharesMintedAsFees,
    },
    {
      abi: Lido.abi,
    }
  )
}

contract('Lido: handleOracleReport', ([appManager, , , , , , bob, stranger, anotherStranger, depositor, operator]) => {
  let deployed, snapshot, lido, treasury, voting, oracle, burner, withdrawalQueue
  let curatedModule, oracleReportSanityChecker, elRewardsVault
  let withdrawalVault
  let strangerBalanceBefore,
    anotherStrangerBalanceBefore,
    totalPooledEtherBefore,
    curatedModuleBalanceBefore,
    treasuryBalanceBefore,
    initialHolderBalanceBefore

  before('deploy base app', async () => {
    deployed = await deployProtocol({
      stakingModulesFactory: async (protocol) => {
        curatedModule = await setupNodeOperatorsRegistry(protocol)
        return [
          {
            module: curatedModule,
            name: 'Curated',
            targetShares: 10000,
            moduleFee: 500,
            treasuryFee: 500,
          },
        ]
      },
      depositSecurityModuleFactory: async (protocol) => {
        return { address: depositor }
      },
    })

    await setBalance(deployed.oracle.address, ETH(1000000))
    await ethers.getImpersonatedSigner(deployed.oracle.address)

    await curatedModule.addNodeOperator('1', operator, { from: deployed.voting.address })
    const keysAmount = 120
    const keys1 = genKeys(keysAmount)
    await curatedModule.addSigningKeys(0, keysAmount, keys1.pubkeys, keys1.sigkeys, { from: deployed.voting.address })
    await curatedModule.setNodeOperatorStakingLimit(0, keysAmount, { from: deployed.voting.address })

    lido = deployed.pool
    burner = deployed.burner
    treasury = deployed.treasury.address
    voting = deployed.voting.address
    oracle = deployed.oracle.address
    oracleReportSanityChecker = deployed.oracleReportSanityChecker
    withdrawalVault = deployed.withdrawalVault.address
    elRewardsVault = deployed.elRewardsVault.address
    withdrawalQueue = deployed.withdrawalQueue

    assert.equals(await lido.balanceOf(INITIAL_HOLDER), StETH(1))
    await lido.submit(ZERO_ADDRESS, { from: stranger, value: ETH(30000000) })
    await lido.submit(ZERO_ADDRESS, { from: anotherStranger, value: ETH(69000000) })

    await checkStat({ depositedValidators: 0, beaconValidators: 0, beaconBalance: 0 })

    snapshot = new EvmSnapshot(ethers.provider)
    await snapshot.make()

    addSendWithResult(lido.handleOracleReport)
  })

  beforeEach(async () => {
    await updateBalancesBefore()
  })

  afterEach(async () => {
    await snapshot.rollback()
  })

  const checkStat = async ({ depositedValidators, beaconValidators, beaconBalance }) => {
    const stat = await lido.getBeaconStat()
    assert.equals(stat.depositedValidators, depositedValidators, 'depositedValidators check')
    assert.equals(stat.beaconValidators, beaconValidators, 'beaconValidators check')
    assert.equals(stat.beaconBalance, beaconBalance, 'beaconBalance check')
  }

  const updateBalancesBefore = async () => {
    totalPooledEtherBefore = await lido.getTotalPooledEther()
    strangerBalanceBefore = await lido.balanceOf(stranger)
    anotherStrangerBalanceBefore = await lido.balanceOf(anotherStranger)
    treasuryBalanceBefore = await lido.balanceOf(treasury)
    curatedModuleBalanceBefore = await lido.balanceOf(curatedModule.address)
    initialHolderBalanceBefore = await lido.balanceOf(INITIAL_HOLDER)
  }

  const checkBalanceDeltas = async ({
    totalPooledEtherDiff,
    treasuryBalanceDiff,
    strangerBalanceDiff,
    anotherStrangerBalanceDiff,
    curatedModuleBalanceDiff,
    initialHolderBalanceDiff,
  }) => {
    assert.equals(
      await lido.getTotalPooledEther(),
      toBN(totalPooledEtherBefore).add(toBN(totalPooledEtherDiff)),
      'totalPooledEther check'
    )
    assert.equalsDelta(
      await lido.balanceOf(treasury),
      toBN(treasuryBalanceBefore).add(toBN(treasuryBalanceDiff)),
      1,
      'treasury balance check'
    )
    assert.equalsDelta(
      await lido.balanceOf(curatedModule.address),
      toBN(curatedModuleBalanceBefore).add(toBN(curatedModuleBalanceDiff)),
      1,
      'curated module balance check'
    )
    assert.equalsDelta(
      await lido.balanceOf(stranger),
      toBN(strangerBalanceBefore).add(toBN(strangerBalanceDiff)),
      1,
      'stranger balance check'
    )
    assert.equalsDelta(
      await lido.balanceOf(anotherStranger),
      toBN(anotherStrangerBalanceBefore).add(toBN(anotherStrangerBalanceDiff)),
      1,
      'another stranger balance check'
    )
    assert.equalsDelta(
      await lido.balanceOf(INITIAL_HOLDER),
      toBN(initialHolderBalanceBefore).add(toBN(initialHolderBalanceDiff)),
      1,
      'another stranger balance check'
    )
  }

  it('handleOracleReport access control', async () => {
    await assert.reverts(
      lido.handleOracleReport(...Object.values(DEFAULT_LIDO_ORACLE_REPORT), { from: stranger }),
      'APP_AUTH_FAILED'
    )
  })

  it('handleOracleReport reverts when protocol is stopped', async () => {
    await lido.stop({ from: deployed.voting.address })
    await assert.reverts(
      lido.handleOracleReport(...Object.values(DEFAULT_LIDO_ORACLE_REPORT), { from: stranger }),
      'CONTRACT_IS_STOPPED'
    )
  })

  it('zero report should do nothing', async () => {
    const tx = await lido.handleOracleReport(...Object.values(DEFAULT_LIDO_ORACLE_REPORT), { from: oracle })
    await checkEvents({
      tx,
      preCLValidators: 0,
      postCLValidators: 0,
      preCLBalance: ETH(0),
      postCLBalance: ETH(0),
      withdrawalsWithdrawn: 0,
      executionLayerRewardsWithdrawn: 0,
      postBufferedEther: ETH(99000001),
      timeElapsed: 0,
      preTotalShares: ETH(99000001),
      preTotalEther: ETH(99000001),
      postTotalShares: ETH(99000001),
      postTotalEther: ETH(99000001),
      sharesMintedAsFees: 0,
    })

    await checkStat({ depositedValidators: 0, beaconValidators: 0, beaconBalance: 0 })
    await checkBalanceDeltas({
      totalPooledEtherDiff: 0,
      treasuryBalanceDiff: 0,
      strangerBalanceDiff: 0,
      anotherStrangerBalanceDiff: 0,
      curatedModuleBalanceDiff: 0,
      initialHolderBalanceDiff: 0,
    })
  })

  describe('clBalance', async () => {
    beforeEach(async () => {
      await lido.deposit(3, 1, '0x', { from: depositor })
      await checkStat({ depositedValidators: 3, beaconValidators: 0, beaconBalance: 0 })
      await checkBalanceDeltas({
        totalPooledEtherDiff: 0,
        treasuryBalanceDiff: 0,
        strangerBalanceDiff: 0,
        anotherStrangerBalanceDiff: 0,
        curatedModuleBalanceDiff: 0,
        initialHolderBalanceDiff: 0,
      })
    })

    it('first report after deposit without rewards', async () => {
      const tx = await lido.handleOracleReport(
        ...Object.values({ ...DEFAULT_LIDO_ORACLE_REPORT, clValidators: 1, postCLBalance: ETH(32000000) }),
        { from: oracle }
      )
      await checkEvents({
        tx,
        preCLValidators: 0,
        postCLValidators: 1,
        preCLBalance: ETH(32000000),
        postCLBalance: ETH(32000000),
        withdrawalsWithdrawn: 0,
        executionLayerRewardsWithdrawn: 0,
        postBufferedEther: ETH(3000001),
        timeElapsed: 0,
        preTotalShares: ETH(99000001),
        preTotalEther: ETH(99000001),
        postTotalShares: ETH(99000001),
        postTotalEther: ETH(99000001),
        sharesMintedAsFees: 0,
      })

      await checkStat({ depositedValidators: 3, beaconValidators: 1, beaconBalance: ETH(32000000) })
      await checkBalanceDeltas({
        totalPooledEtherDiff: 0,
        treasuryBalanceDiff: 0,
        strangerBalanceDiff: 0,
        anotherStrangerBalanceDiff: 0,
        curatedModuleBalanceDiff: 0,
        initialHolderBalanceDiff: 0,
      })
    })

    it('first report after deposit with rewards', async () => {
      const tx = await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_YEAR,
          clValidators: 1,
          postCLBalance: ETH(33000000),
        }),
        { from: oracle }
      )
      const sharesMintedAsFees = calcSharesMintedAsFees(ETH(1000000), 10, 100, ETH(99000001), ETH(100000001))
      await checkEvents({
        tx,
        preCLValidators: 0,
        postCLValidators: 1,
        preCLBalance: ETH(32000000),
        postCLBalance: ETH(33000000),
        withdrawalsWithdrawn: 0,
        executionLayerRewardsWithdrawn: 0,
        postBufferedEther: ETH(3000001),
        timeElapsed: ONE_YEAR,
        preTotalShares: ETH(99000001),
        preTotalEther: ETH(99000001),
        postTotalShares: toBN(ETH(99000001)).add(sharesMintedAsFees).toString(),
        postTotalEther: ETH(100000001),
        sharesMintedAsFees: sharesMintedAsFees.toString(),
      })

      await checkStat({ depositedValidators: 3, beaconValidators: 1, beaconBalance: ETH(33000000) })
    })
  })

  describe('sanity checks', async () => {
    beforeEach(async () => {
      await lido.deposit(3, 1, '0x', { from: depositor })
    })

    it('reverts on reported more than deposited', async () => {
      await assert.reverts(
        lido.handleOracleReport(...Object.values({ ...DEFAULT_LIDO_ORACLE_REPORT, clValidators: 4 }), { from: oracle }),
        'REPORTED_MORE_DEPOSITED'
      )
    })

    it('reverts on reported less than reported previously', async () => {
      await lido.handleOracleReport(
        ...Object.values({ ...DEFAULT_LIDO_ORACLE_REPORT, clValidators: 3, postCLBalance: ETH(96000000) }),
        { from: oracle }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })
      await assert.reverts(
        lido.handleOracleReport(...Object.values({ ...DEFAULT_LIDO_ORACLE_REPORT, clValidators: 2 }), { from: oracle }),
        'REPORTED_LESS_VALIDATORS'
      )
    })

    it('withdrawal vault balance check', async () => {
      await assert.reverts(
        lido.handleOracleReport(...Object.values({ ...DEFAULT_LIDO_ORACLE_REPORT, withdrawalVaultBalance: 1 }), {
          from: oracle,
        }),
        'IncorrectWithdrawalsVaultBalance(0)'
      )
    })

    it('execution layer rewards vault balance check', async () => {
      await assert.reverts(
        lido.handleOracleReport(...Object.values({ ...DEFAULT_LIDO_ORACLE_REPORT, elRewardsVaultBalance: 1 }), {
          from: oracle,
        }),
        'IncorrectELRewardsVaultBalance(0)'
      )
    })

    it('burner shares to burn check', async () => {
      await assert.reverts(
        lido.handleOracleReport(...Object.values({ ...DEFAULT_LIDO_ORACLE_REPORT, sharesRequestedToBurn: 1 }), {
          from: oracle,
        }),
        'IncorrectSharesRequestedToBurn(0)'
      )
    })

    it('does not revert on new total balance stay the same', async () => {
      let tx = await lido.handleOracleReport(
        ...Object.values({ ...DEFAULT_LIDO_ORACLE_REPORT, clValidators: 3, postCLBalance: ETH(96000000) }),
        { from: oracle }
      )
      await checkEvents({
        tx,
        preCLValidators: 0,
        postCLValidators: 3,
        preCLBalance: ETH(96000000),
        postCLBalance: ETH(96000000),
        withdrawalsWithdrawn: 0,
        executionLayerRewardsWithdrawn: 0,
        postBufferedEther: ETH(3000001),
        timeElapsed: 0,
        preTotalShares: ETH(99000001),
        preTotalEther: ETH(99000001),
        postTotalShares: ETH(99000001),
        postTotalEther: ETH(99000001),
        sharesMintedAsFees: 0,
      })
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })
      await checkBalanceDeltas({
        totalPooledEtherDiff: 0,
        treasuryBalanceDiff: 0,
        strangerBalanceDiff: 0,
        anotherStrangerBalanceDiff: 0,
        curatedModuleBalanceDiff: 0,
        initialHolderBalanceDiff: 0,
      })
      tx = await lido.handleOracleReport(
        ...Object.values({ ...DEFAULT_LIDO_ORACLE_REPORT, clValidators: 3, postCLBalance: ETH(96000000) }),
        { from: oracle }
      )
      await checkEvents({
        tx,
        preCLValidators: 3,
        postCLValidators: 3,
        preCLBalance: ETH(96000000),
        postCLBalance: ETH(96000000),
        withdrawalsWithdrawn: 0,
        executionLayerRewardsWithdrawn: 0,
        postBufferedEther: ETH(3000001),
        timeElapsed: 0,
        preTotalShares: ETH(99000001),
        preTotalEther: ETH(99000001),
        postTotalShares: ETH(99000001),
        postTotalEther: ETH(99000001),
        sharesMintedAsFees: 0,
      })
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })
      await checkBalanceDeltas({
        totalPooledEtherDiff: 0,
        treasuryBalanceDiff: 0,
        strangerBalanceDiff: 0,
        anotherStrangerBalanceDiff: 0,
        curatedModuleBalanceDiff: 0,
        initialHolderBalanceDiff: 0,
      })
    })

    it('does not revert on new total balance decrease under the limit', async () => {
      // set oneOffCLBalanceDecreaseBPLimit = 1%
      await oracleReportSanityChecker.setOracleReportLimits(ORACLE_REPORT_LIMITS_BOILERPLATE, { from: voting })

      let tx = await lido.handleOracleReport(
        ...Object.values({ ...DEFAULT_LIDO_ORACLE_REPORT, clValidators: 3, postCLBalance: ETH(96000000) }),
        { from: oracle }
      )
      await checkEvents({
        tx,
        preCLValidators: 0,
        postCLValidators: 3,
        preCLBalance: ETH(96000000),
        postCLBalance: ETH(96000000),
        withdrawalsWithdrawn: 0,
        executionLayerRewardsWithdrawn: 0,
        postBufferedEther: ETH(3000001),
        timeElapsed: 0,
        preTotalShares: ETH(99000001),
        preTotalEther: ETH(99000001),
        postTotalShares: ETH(99000001),
        postTotalEther: ETH(99000001),
        sharesMintedAsFees: 0,
      })
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })
      await checkBalanceDeltas({
        totalPooledEtherDiff: 0,
        treasuryBalanceDiff: 0,
        strangerBalanceDiff: 0,
        anotherStrangerBalanceDiff: 0,
        curatedModuleBalanceDiff: 0,
        initialHolderBalanceDiff: 0,
      })
      tx = await lido.handleOracleReport(
        ...Object.values({ ...DEFAULT_LIDO_ORACLE_REPORT, clValidators: 3, postCLBalance: ETH(95040000) }),
        { from: oracle }
      )
      await checkEvents({
        tx,
        preCLValidators: 3,
        postCLValidators: 3,
        preCLBalance: ETH(96000000),
        postCLBalance: ETH(95040000),
        withdrawalsWithdrawn: 0,
        executionLayerRewardsWithdrawn: 0,
        postBufferedEther: ETH(3000001),
        timeElapsed: 0,
        preTotalShares: ETH(99000001),
        preTotalEther: ETH(99000001),
        postTotalShares: ETH(99000001),
        postTotalEther: ETH(98040001),
        sharesMintedAsFees: 0,
      })
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(95040000) })
    })

    it('reverts on new total balance decrease over the limit', async () => {
      // set oneOffCLBalanceDecreaseBPLimit = 1%
      await oracleReportSanityChecker.setOracleReportLimits(ORACLE_REPORT_LIMITS_BOILERPLATE, { from: voting })

      await lido.handleOracleReport(
        ...Object.values({ ...DEFAULT_LIDO_ORACLE_REPORT, clValidators: 3, postCLBalance: ETH(96000000) }),
        { from: oracle }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })
      await checkBalanceDeltas({
        totalPooledEtherDiff: 0,
        treasuryBalanceDiff: 0,
        strangerBalanceDiff: 0,
        anotherStrangerBalanceDiff: 0,
        curatedModuleBalanceDiff: 0,
        initialHolderBalanceDiff: 0,
      })
      await assert.reverts(
        lido.handleOracleReport(
          ...Object.values({ ...DEFAULT_LIDO_ORACLE_REPORT, clValidators: 3, postCLBalance: ETH(95030000) }),
          { from: oracle }
        ),
        'IncorrectCLBalanceDecrease(101)'
      )
    })

    it('does not revert on new total balance increase under the limit', async () => {
      // set annualBalanceIncreaseBPLimit = 1%
      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          annualBalanceIncreaseBPLimit: 100,
        },
        { from: voting }
      )

      await lido.handleOracleReport(
        ...Object.values({ ...DEFAULT_LIDO_ORACLE_REPORT, clValidators: 3, postCLBalance: ETH(96000000) }),
        { from: oracle }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })
      await checkBalanceDeltas({
        totalPooledEtherDiff: 0,
        treasuryBalanceDiff: 0,
        strangerBalanceDiff: 0,
        anotherStrangerBalanceDiff: 0,
        curatedModuleBalanceDiff: 0,
        initialHolderBalanceDiff: 0,
      })
      const tx = await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_YEAR,
          clValidators: 3,
          postCLBalance: ETH(96960000),
        }),
        { from: oracle }
      )
      const sharesMintedAsFees = calcSharesMintedAsFees(ETH(960000), 10, 100, ETH(99000001), ETH(99960001))
      await checkEvents({
        tx,
        preCLValidators: 3,
        postCLValidators: 3,
        preCLBalance: ETH(96000000),
        postCLBalance: ETH(96960000),
        withdrawalsWithdrawn: 0,
        executionLayerRewardsWithdrawn: 0,
        postBufferedEther: ETH(3000001),
        timeElapsed: ONE_YEAR,
        preTotalShares: ETH(99000001),
        preTotalEther: ETH(99000001),
        postTotalShares: toBN(ETH(99000001)).add(sharesMintedAsFees).toString(),
        postTotalEther: ETH(99960001),
        sharesMintedAsFees: sharesMintedAsFees.toString(),
      })
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96960000) })
    })

    it('reverts on new total balance increase over the limit', async () => {
      // set annualBalanceIncreaseBPLimit = 1%
      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          annualBalanceIncreaseBPLimit: 100,
        },
        { from: voting }
      )

      await lido.handleOracleReport(
        ...Object.values({ ...DEFAULT_LIDO_ORACLE_REPORT, clValidators: 3, postCLBalance: ETH(96000000) }),
        { from: oracle }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })
      await checkBalanceDeltas({
        totalPooledEtherDiff: 0,
        treasuryBalanceDiff: 0,
        strangerBalanceDiff: 0,
        anotherStrangerBalanceDiff: 0,
        curatedModuleBalanceDiff: 0,
        initialHolderBalanceDiff: 0,
      })
      await assert.reverts(
        lido.handleOracleReport(
          ...Object.values({
            ...DEFAULT_LIDO_ORACLE_REPORT,
            timeElapsed: ONE_YEAR,
            clValidators: 3,
            postCLBalance: ETH(96970000),
          }),
          { from: oracle }
        ),
        'IncorrectCLBalanceIncrease(101)'
      )
    })

    it('does not revert on validators reported under limit', async () => {
      await lido.submit(ZERO_ADDRESS, { from: stranger, value: ETH(3200000000), gasPrice: 1 })
      await lido.deposit(100, 1, '0x', { from: depositor })
      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          annualBalanceIncreaseBPLimit: 100,
        },
        { from: voting, gasPrice: 1 }
      )

      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 100,
          postCLBalance: ETH(3200000000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 103, beaconValidators: 100, beaconBalance: ETH(3200000000) })
    })

    it('reverts on validators reported when over limit', async () => {
      await lido.submit(ZERO_ADDRESS, { from: stranger, value: ETH(3200000000), gasPrice: 1 })
      await lido.deposit(101, 1, '0x', { from: depositor })
      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          annualBalanceIncreaseBPLimit: 100,
        },
        { from: voting, gasPrice: 1 }
      )
      await assert.reverts(
        lido.handleOracleReport(
          ...Object.values({
            ...DEFAULT_LIDO_ORACLE_REPORT,
            timeElapsed: ONE_DAY,
            clValidators: 101,
            postCLBalance: ETH(3200000000),
          }),
          { from: oracle, gasPrice: 1 }
        ),
        'IncorrectAppearedValidators(101)'
      )
    })
  })

  describe('smooth report', async () => {
    beforeEach(async () => {
      await lido.deposit(3, 1, '0x', { from: depositor })
      await checkStat({ depositedValidators: 3, beaconValidators: 0, beaconBalance: 0 })
      await checkBalanceDeltas({
        totalPooledEtherDiff: 0,
        treasuryBalanceDiff: 0,
        strangerBalanceDiff: 0,
        anotherStrangerBalanceDiff: 0,
        curatedModuleBalanceDiff: 0,
        initialHolderBalanceDiff: 0,
      })
    })

    it('does not smooth if report in limits', async () => {
      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_YEAR,
          clValidators: 3,
          postCLBalance: ETH(97000000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(97000000) })
    })

    it('does not smooth if cl balance report over limit', async () => {
      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_YEAR,
          clValidators: 3,
          postCLBalance: ETH(100000000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(100000000) })
    })

    it('does not smooth withdrawals if report in limits', async () => {
      await setBalance(withdrawalVault, ETH(1000000))

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          annualBalanceIncreaseBPLimit: 100,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_YEAR,
          clValidators: 3,
          postCLBalance: ETH(96000000),
          withdrawalVaultBalance: ETH(1000000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })
      assert.equals(await ethers.provider.getBalance(withdrawalVault), 0)
    })

    it('smooths withdrawals if report out of limit', async () => {
      await setBalance(withdrawalVault, ETH(1100000))

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          maxPositiveTokenRebase: 10000000,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_YEAR,
          clValidators: 3,
          postCLBalance: ETH(96000000),
          withdrawalVaultBalance: ETH(1100000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })
    })

    it('does not smooth el rewards if report in limit without lido fee', async () => {
      await setBalance(elRewardsVault, ETH(1000000))

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          maxPositiveTokenRebase: 10000000,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_YEAR,
          clValidators: 3,
          postCLBalance: ETH(96000000),
          elRewardsVaultBalance: ETH(1000000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })

      assert.equals(await ethers.provider.getBalance(elRewardsVault), ETH(9999.99))
    })

    it('does not smooth el rewards if report in limit without lido fee 2', async () => {
      await setBalance(elRewardsVault, ETH(1500000))

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          maxPositiveTokenRebase: 10000000,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_YEAR,
          clValidators: 3,
          postCLBalance: ETH(95500000),
          elRewardsVaultBalance: ETH(1500000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(95500000) })

      assert.equals(await ethers.provider.getBalance(elRewardsVault), ETH(9999.99))
    })

    it('smooths el rewards if report out of limit without lido fee', async () => {
      await setBalance(elRewardsVault, ETH(1100000))

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          maxPositiveTokenRebase: 10000000,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_YEAR,
          clValidators: 3,
          postCLBalance: ETH(96000000),
          elRewardsVaultBalance: ETH(1100000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })

      assert.equals(await ethers.provider.getBalance(elRewardsVault), ETH(109999.99))
    })

    it('does not smooth el rewards if report in limit', async () => {
      await setBalance(elRewardsVault, ETH(1000000))

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_YEAR,
          clValidators: 3,
          postCLBalance: ETH(96100000),
          elRewardsVaultBalance: ETH(900000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96100000) })

      assert.equals(await ethers.provider.getBalance(elRewardsVault), ETH(100000))
    })

    it('smooths el rewards if report out of limit', async () => {
      await setBalance(elRewardsVault, ETH(1100000))

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          maxPositiveTokenRebase: 10000000,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_YEAR,
          clValidators: 3,
          postCLBalance: ETH(96100000),
          elRewardsVaultBalance: ETH(1100000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96100000) })

      assert.equals(await ethers.provider.getBalance(elRewardsVault), ETH(209999.99))
    })

    it('does not smooth shares to burn if report in limit with shares', async () => {
      await lido.submit(ZERO_ADDRESS, { from: bob, value: ETH(1000000) })

      const sharesToBurn = await lido.sharesOf(bob)
      await lido.approve(burner.address, await lido.balanceOf(bob), { from: bob })
      await burner.requestBurnShares(bob, sharesToBurn, { from: voting })
      const { coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn()
      assert.equals(coverShares.add(nonCoverShares), sharesToBurn)

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          maxPositiveTokenRebase: 10000000, // 1%
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_YEAR,
          clValidators: 3,
          postCLBalance: ETH(96000000),
          sharesRequestedToBurn: sharesToBurn,
        }),
        { from: oracle, gasPrice: 1 }
      )
      // await checkEvents({
      //   tx,
      //   preCLValidators: 0,
      //   postCLValidators: 3,
      //   preCLBalance: ETH(96000000),
      //   postCLBalance: ETH(96000000),
      //   withdrawalsWithdrawn: 0,
      //   executionLayerRewardsWithdrawn: ETH(0),
      //   postBufferedEther: ETH(4000001),
      //   timeElapsed: ONE_YEAR,
      //   preTotalShares: ETH(100000001),
      //   preTotalEther: ETH(100000001),
      //   postTotalShares: toBN(ETH(100000001)).sub(sharesToBurn).toString(),
      //   postTotalEther: ETH(100000001),
      //   sharesMintedAsFees: 0,
      // })

      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })
      assert.equals(coverShares.add(nonCoverShares), StETH(1000000))
      assert.equals(await lido.balanceOf(burner.address), StETH(9999.99))
    })

    it('smooth shares to burn if report in limit without shares and no fees', async () => {
      await lido.submit(ZERO_ADDRESS, { from: bob, value: ETH(1000000) })
      await setBalance(elRewardsVault, ETH(500000))

      const sharesRequestedToBurn = await lido.sharesOf(bob)
      await lido.approve(burner.address, await lido.balanceOf(bob), { from: bob })
      await burner.requestBurnShares(bob, sharesRequestedToBurn, { from: voting })
      let { coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn()
      assert.equals(coverShares.add(nonCoverShares), sharesRequestedToBurn)

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          maxPositiveTokenRebase: 10000000, // 1%
        },
        { from: voting, gasPrice: 1 }
      )

      const tx = await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_YEAR,
          clValidators: 3,
          postCLBalance: ETH(96000000),
          elRewardsVaultBalance: ETH(500000),
          sharesRequestedToBurn: sharesRequestedToBurn.toString(),
        }),
        { from: oracle, gasPrice: 1 }
      )

      const { elBalanceUpdate, sharesToBurn } = limitRebase(
        toBN(10000000),
        ETH(100000001),
        ETH(100000001),
        ETH(0),
        ETH(500000),
        sharesRequestedToBurn
      )

      const postTotalShares = toBN(ETH(100000001)).sub(toBN(sharesToBurn))
      const postTotalEther = toBN(ETH(100000001)).add(toBN(elBalanceUpdate))

      await checkEvents({
        tx,
        preCLValidators: 0,
        postCLValidators: 3,
        preCLBalance: ETH(96000000),
        postCLBalance: ETH(96000000),
        withdrawalsWithdrawn: 0,
        executionLayerRewardsWithdrawn: ETH(500000),
        postBufferedEther: ETH(4500001),
        timeElapsed: ONE_YEAR,
        preTotalShares: ETH(100000001),
        preTotalEther: ETH(100000001),
        postTotalShares: postTotalShares.toString(),
        postTotalEther: postTotalEther.toString(),
        sharesMintedAsFees: 0, // no rewards on CL side => no minted fee
      })
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })
      assert.equals(await ethers.provider.getBalance(elRewardsVault), ETH(0))
      ;({ coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn())
      assert.equals(sharesRequestedToBurn.sub(coverShares.add(nonCoverShares)), sharesToBurn)
      assert.equals(
        await lido.balanceOf(burner.address),
        await lido.getPooledEthByShares(toBN(sharesRequestedToBurn).sub(sharesToBurn))
      )
    })

    it('smooth shares to burn if report in limit without shares and some fees', async () => {
      await lido.submit(ZERO_ADDRESS, { from: bob, value: ETH(1000000) })
      await setBalance(elRewardsVault, ETH(400000))

      const sharesRequestedToBurn = await lido.sharesOf(bob)
      await lido.approve(burner.address, await lido.balanceOf(bob), { from: bob })
      await burner.requestBurnShares(bob, sharesRequestedToBurn, { from: voting })
      let { coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn()
      assert.equals(coverShares.add(nonCoverShares), sharesRequestedToBurn)

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          maxPositiveTokenRebase: 10000000, // 1%
        },
        { from: voting, gasPrice: 1 }
      )

      const tx = await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_YEAR,
          clValidators: 3,
          postCLBalance: ETH(96100000),
          elRewardsVaultBalance: ETH(400000),
          sharesRequestedToBurn: sharesRequestedToBurn.toString(),
        }),
        { from: oracle, gasPrice: 1 }
      )

      const { elBalanceUpdate, sharesToBurn } = limitRebase(
        toBN(10000000),
        ETH(100000001),
        ETH(100000001),
        ETH(100000),
        ETH(400000),
        sharesRequestedToBurn
      )

      const postTotalEther = toBN(ETH(100100001)).add(toBN(elBalanceUpdate))
      const sharesMintedAsFees = calcSharesMintedAsFees(ETH(500000), 10, 100, ETH(100000001), postTotalEther)
      const postTotalShares = toBN(ETH(100000001)).add(sharesMintedAsFees).sub(toBN(sharesToBurn))

      await checkEvents({
        tx,
        preCLValidators: 0,
        postCLValidators: 3,
        preCLBalance: ETH(96000000),
        postCLBalance: ETH(96100000),
        withdrawalsWithdrawn: 0,
        executionLayerRewardsWithdrawn: ETH(400000),
        postBufferedEther: ETH(4400001),
        timeElapsed: ONE_YEAR,
        preTotalShares: ETH(100000001),
        preTotalEther: ETH(100000001),
        postTotalShares: postTotalShares.toString(),
        postTotalEther: postTotalEther.toString(),
        sharesMintedAsFees: sharesMintedAsFees.toString(),
      })
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96100000) })
      assert.equals(await ethers.provider.getBalance(elRewardsVault), ETH(0))
      ;({ coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn())
      assert.equals(sharesRequestedToBurn.sub(coverShares.add(nonCoverShares)), sharesToBurn)
      assert.equals(
        await lido.balanceOf(burner.address),
        await lido.getPooledEthByShares(toBN(sharesRequestedToBurn).sub(sharesToBurn))
      )
    })

    it('postpone all shares to burn if report out of limit even without shares', async () => {
      await lido.submit(ZERO_ADDRESS, { from: bob, value: ETH(1000000) })
      await setBalance(elRewardsVault, ETH(4900000))

      const sharesRequestedToBurn = await lido.sharesOf(bob)
      await lido.approve(burner.address, await lido.balanceOf(bob), { from: bob })
      await burner.requestBurnShares(bob, sharesRequestedToBurn, { from: voting })
      let { coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn()
      assert.equals(coverShares.add(nonCoverShares), sharesRequestedToBurn)

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          maxPositiveTokenRebase: 10000000, // 1%
        },
        { from: voting, gasPrice: 1 }
      )

      const tx = await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_YEAR,
          clValidators: 3,
          postCLBalance: ETH(96100000),
          elRewardsVaultBalance: ETH(4900000),
          sharesRequestedToBurn: sharesRequestedToBurn.toString(),
        }),
        { from: oracle, gasPrice: 1 }
      )

      const { elBalanceUpdate, sharesToBurn } = limitRebase(
        toBN(10000000),
        ETH(100000001),
        ETH(100000001),
        ETH(100000),
        ETH(4900000),
        sharesRequestedToBurn
      )

      const postTotalEther = toBN(ETH(100100001)).add(toBN(elBalanceUpdate))
      const sharesMintedAsFees = calcSharesMintedAsFees(
        toBN(ETH(100000)).add(elBalanceUpdate),
        10,
        100,
        ETH(100000001),
        postTotalEther
      )
      const postTotalShares = toBN(ETH(100000001)).add(sharesMintedAsFees).sub(toBN(sharesToBurn))

      await checkEvents({
        tx,
        preCLValidators: 0,
        postCLValidators: 3,
        preCLBalance: ETH(96000000),
        postCLBalance: ETH(96100000),
        withdrawalsWithdrawn: 0,
        executionLayerRewardsWithdrawn: elBalanceUpdate.toString(),
        postBufferedEther: toBN(ETH(4000001)).add(elBalanceUpdate).toString(),
        timeElapsed: ONE_YEAR,
        preTotalShares: ETH(100000001),
        preTotalEther: ETH(100000001),
        postTotalShares: postTotalShares.toString(),
        postTotalEther: postTotalEther.toString(),
        sharesMintedAsFees: sharesMintedAsFees.toString(),
      })
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96100000) })

      assert.equals(await ethers.provider.getBalance(elRewardsVault), toBN(ETH(4900000)).sub(elBalanceUpdate))
      ;({ coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn())
      assert.equals(sharesToBurn, 0)
      assert.equals(coverShares.add(nonCoverShares), sharesRequestedToBurn)
      assert.equals(await lido.balanceOf(burner.address), await lido.getPooledEthByShares(sharesRequestedToBurn))
    })
  })

  describe('daily reports', async () => {
    beforeEach(async () => {
      await lido.deposit(3, 1, '0x', { from: depositor })
      await checkStat({ depositedValidators: 3, beaconValidators: 0, beaconBalance: 0 })
      await checkBalanceDeltas({
        totalPooledEtherDiff: 0,
        treasuryBalanceDiff: 0,
        strangerBalanceDiff: 0,
        anotherStrangerBalanceDiff: 0,
        curatedModuleBalanceDiff: 0,
        initialHolderBalanceDiff: 0,
      })
    })
    it('smooths el rewards if report out of limit', async () => {
      await setBalance(elRewardsVault, ETH(1100000))

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          maxPositiveTokenRebase: 10000000,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96100000),
          elRewardsVaultBalance: ETH(1100000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96100000) })

      assert.equals(await ethers.provider.getBalance(elRewardsVault), ETH(209999.99))
    })
    it('does not smooth if report in limits', async () => {
      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96002700),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96002700) })
    })

    it('does not smooth if cl balance report over limit', async () => {
      const clIncrease = 2800
      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96002800),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000 + clIncrease) })
    })

    it('does not smooth withdrawals if report in limits', async () => {
      await setBalance(withdrawalVault, ETH(1000000))

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          annualBalanceIncreaseBPLimit: 100,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96000000),
          withdrawalVaultBalance: ETH(1000000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })
      assert.equals(await ethers.provider.getBalance(withdrawalVault), 0)
    })

    it('smooths withdrawals if report out of limit', async () => {
      await setBalance(withdrawalVault, ETH(1100000))

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          maxPositiveTokenRebase: 10000000,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96000000),
          withdrawalVaultBalance: ETH(1100000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })

      assert.equals(await ethers.provider.getBalance(withdrawalVault), ETH(109999.99))
    })

    it('does not smooth el rewards if report in limit without lido fee', async () => {
      await setBalance(elRewardsVault, ETH(1000000))

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          maxPositiveTokenRebase: 10000000,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96000000),
          elRewardsVaultBalance: ETH(1000000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })

      assert.equals(await ethers.provider.getBalance(elRewardsVault), ETH(9999.99))
    })

    it('does not smooth el rewards if report in limit without lido fee 2', async () => {
      await setBalance(elRewardsVault, ETH(1500000))

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          maxPositiveTokenRebase: 10000000,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(95500000),
          elRewardsVaultBalance: ETH(1500000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(95500000) })

      assert.equals(await ethers.provider.getBalance(elRewardsVault), ETH(9999.99))
    })

    it('smooths el rewards if report out of limit without lido fee', async () => {
      await setBalance(elRewardsVault, ETH(1100000))

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          maxPositiveTokenRebase: 10000000,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96000000),
          elRewardsVaultBalance: ETH(1100000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })

      assert.equals(await ethers.provider.getBalance(elRewardsVault), ETH(109999.99))
    })

    it('does not smooth el rewards if report in limit', async () => {
      await setBalance(elRewardsVault, ETH(1000000))

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
        },
        { from: voting, gasPrice: 1 }
      )
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96100000),
          elRewardsVaultBalance: ETH(900000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96100000) })

      assert.equals(await ethers.provider.getBalance(elRewardsVault), ETH(100000))
    })

    it('does not smooth shares to burn if report in limit with shares', async () => {
      await lido.submit(ZERO_ADDRESS, { from: bob, value: ETH(1000000) })

      const sharesToBurn = await lido.sharesOf(bob)
      await lido.approve(burner.address, await lido.balanceOf(bob), { from: bob })
      await burner.requestBurnShares(bob, sharesToBurn, { from: voting })
      let { coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn()
      assert.equals(coverShares.add(nonCoverShares), sharesToBurn)

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          maxPositiveTokenRebase: 10000000,
        },
        { from: voting, gasPrice: 1 }
      )

      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96000000),
          sharesRequestedToBurn: sharesToBurn,
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })
      ;({ coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn())
      assert.equals(await lido.balanceOf(burner.address), StETH(9999.99))
    })

    it('smooth shares to burn if report in limit without shares and no fees', async () => {
      await lido.submit(ZERO_ADDRESS, { from: bob, value: ETH(1000000) })
      await setBalance(elRewardsVault, ETH(500000))

      const sharesRequestedToBurn = await lido.sharesOf(bob)
      await lido.approve(burner.address, await lido.balanceOf(bob), { from: bob })
      await burner.requestBurnShares(bob, sharesRequestedToBurn, { from: voting })
      let { coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn()
      assert.equals(coverShares.add(nonCoverShares), sharesRequestedToBurn)

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          maxPositiveTokenRebase: 10000000,
        },
        { from: voting, gasPrice: 1 }
      )
      const tx = await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96000000),
          elRewardsVaultBalance: ETH(500000),
          sharesRequestedToBurn: sharesRequestedToBurn.toString(),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })

      const { elBalanceUpdate, sharesToBurn } = limitRebase(
        toBN(10000000),
        ETH(100000001),
        ETH(100000001),
        ETH(0),
        ETH(500000),
        sharesRequestedToBurn
      )

      const postTotalShares = toBN(ETH(100000001)).sub(toBN(sharesToBurn))
      const postTotalEther = toBN(ETH(100000001)).add(toBN(elBalanceUpdate))

      await checkEvents({
        tx,
        preCLValidators: 0,
        postCLValidators: 3,
        preCLBalance: ETH(96000000),
        postCLBalance: ETH(96000000),
        withdrawalsWithdrawn: 0,
        executionLayerRewardsWithdrawn: ETH(500000),
        postBufferedEther: ETH(4500001),
        timeElapsed: ONE_DAY, // NB: day-long
        preTotalShares: ETH(100000001),
        preTotalEther: ETH(100000001),
        postTotalShares: postTotalShares.toString(),
        postTotalEther: postTotalEther.toString(),
        sharesMintedAsFees: 0, // no rewards on CL side => no minted fee
      })
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })

      assert.equals(await ethers.provider.getBalance(elRewardsVault), ETH(0))
      ;({ coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn())
      assert.equals(sharesRequestedToBurn.sub(coverShares.add(nonCoverShares)), sharesToBurn)
      assert.equals(
        await lido.balanceOf(burner.address),
        await lido.getPooledEthByShares(toBN(sharesRequestedToBurn).sub(sharesToBurn))
      )
    })

    it('smooth shares to burn if report in limit without shares and some fees', async () => {
      await lido.submit(ZERO_ADDRESS, { from: bob, value: ETH(1000000) })
      await setBalance(elRewardsVault, ETH(400000))

      const sharesRequestedToBurn = await lido.sharesOf(bob)
      await lido.approve(burner.address, await lido.balanceOf(bob), { from: bob })
      await burner.requestBurnShares(bob, sharesRequestedToBurn, { from: voting })
      let { coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn()
      assert.equals(coverShares.add(nonCoverShares), sharesRequestedToBurn)

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          maxPositiveTokenRebase: 10000000, // 1%
        },
        { from: voting, gasPrice: 1 }
      )

      const tx = await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96100000),
          elRewardsVaultBalance: ETH(400000),
          sharesRequestedToBurn: sharesRequestedToBurn.toString(),
        }),
        { from: oracle, gasPrice: 1 }
      )

      const { elBalanceUpdate, sharesToBurn } = limitRebase(
        toBN(10000000),
        ETH(100000001),
        ETH(100000001),
        ETH(100000),
        ETH(400000),
        sharesRequestedToBurn
      )

      const postTotalEther = toBN(ETH(100100001)).add(toBN(elBalanceUpdate))
      const sharesMintedAsFees = calcSharesMintedAsFees(ETH(500000), 10, 100, ETH(100000001), postTotalEther)
      const postTotalShares = toBN(ETH(100000001)).add(sharesMintedAsFees).sub(toBN(sharesToBurn))

      await checkEvents({
        tx,
        preCLValidators: 0,
        postCLValidators: 3,
        preCLBalance: ETH(96000000),
        postCLBalance: ETH(96100000),
        withdrawalsWithdrawn: 0,
        executionLayerRewardsWithdrawn: ETH(400000),
        postBufferedEther: ETH(4400001),
        timeElapsed: ONE_DAY,
        preTotalShares: ETH(100000001),
        preTotalEther: ETH(100000001),
        postTotalShares: postTotalShares.toString(),
        postTotalEther: postTotalEther.toString(),
        sharesMintedAsFees: sharesMintedAsFees.toString(),
      })
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96100000) })
      assert.equals(await ethers.provider.getBalance(elRewardsVault), ETH(0))
      ;({ coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn())
      assert.equals(sharesRequestedToBurn.sub(coverShares.add(nonCoverShares)), sharesToBurn)
      assert.equals(
        await lido.balanceOf(burner.address),
        await lido.getPooledEthByShares(toBN(sharesRequestedToBurn).sub(sharesToBurn))
      )
    })

    it('postpone all shares to burn if report out of limit without shares', async () => {
      await lido.submit(ZERO_ADDRESS, { from: bob, value: ETH(1000000) })
      await setBalance(elRewardsVault, ETH(4900000))

      const sharesRequestedToBurn = await lido.sharesOf(bob)
      await lido.approve(burner.address, await lido.balanceOf(bob), { from: bob })
      await burner.requestBurnShares(bob, sharesRequestedToBurn, { from: voting })
      let { coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn()
      assert.equals(coverShares.add(nonCoverShares), sharesRequestedToBurn)

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          maxPositiveTokenRebase: 10000000, // 1%
        },
        { from: voting, gasPrice: 1 }
      )

      const tx = await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96100000),
          elRewardsVaultBalance: ETH(4900000),
          sharesRequestedToBurn: sharesRequestedToBurn.toString(),
        }),
        { from: oracle, gasPrice: 1 }
      )

      const { elBalanceUpdate, sharesToBurn } = limitRebase(
        toBN(10000000),
        ETH(100000001),
        ETH(100000001),
        ETH(100000),
        ETH(4900000),
        sharesRequestedToBurn
      )

      const postTotalEther = toBN(ETH(100100001)).add(toBN(elBalanceUpdate))
      const sharesMintedAsFees = calcSharesMintedAsFees(
        toBN(ETH(100000)).add(elBalanceUpdate),
        10,
        100,
        ETH(100000001),
        postTotalEther
      )
      const postTotalShares = toBN(ETH(100000001)).add(sharesMintedAsFees).sub(toBN(sharesToBurn))

      await checkEvents({
        tx,
        preCLValidators: 0,
        postCLValidators: 3,
        preCLBalance: ETH(96000000),
        postCLBalance: ETH(96100000),
        withdrawalsWithdrawn: 0,
        executionLayerRewardsWithdrawn: elBalanceUpdate.toString(),
        postBufferedEther: toBN(ETH(4000001)).add(elBalanceUpdate).toString(),
        timeElapsed: ONE_DAY,
        preTotalShares: ETH(100000001),
        preTotalEther: ETH(100000001),
        postTotalShares: postTotalShares.toString(),
        postTotalEther: postTotalEther.toString(),
        sharesMintedAsFees: sharesMintedAsFees.toString(),
      })
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96100000) })

      assert.equals(await ethers.provider.getBalance(elRewardsVault), toBN(ETH(4900000)).sub(elBalanceUpdate))
      ;({ coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn())
      assert.equals(sharesToBurn, 0)
      assert.equals(coverShares.add(nonCoverShares), sharesRequestedToBurn)
      assert.equals(await lido.balanceOf(burner.address), await lido.getPooledEthByShares(sharesRequestedToBurn))
    })
  })

  describe('reports with withdrawals finalization', () => {
    beforeEach(async () => {
      await lido.deposit(3, 1, '0x', { from: depositor })
      await checkStat({ depositedValidators: 3, beaconValidators: 0, beaconBalance: 0 })
      await checkBalanceDeltas({
        totalPooledEtherDiff: 0,
        treasuryBalanceDiff: 0,
        strangerBalanceDiff: 0,
        anotherStrangerBalanceDiff: 0,
        curatedModuleBalanceDiff: 0,
        initialHolderBalanceDiff: 0,
      })
    })

    it('dry-run eth_call works and returns proper values', async () => {
      await setBalance(elRewardsVault, ETH(500000))
      await setBalance(withdrawalVault, ETH(500000))

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          maxPositiveTokenRebase: 10000000,
        },
        { from: voting, gasPrice: 1 }
      )

      const [postTotalPooledEther, withdrawals, elRewards] = await lido.handleOracleReport.call(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96100000),
          elRewardsVaultBalance: ETH(500000),
          withdrawalVaultBalance: ETH(500000),
        }),
        { from: oracle, gasPrice: 1 }
      )

      await checkStat({ depositedValidators: 3, beaconValidators: 0, beaconBalance: ETH(0) })
      assert.equals(await ethers.provider.getBalance(elRewardsVault), ETH(500000))
      assert.equals(await ethers.provider.getBalance(withdrawalVault), ETH(500000))

      assert.equals(postTotalPooledEther, ETH(99990001.01))
      assert.equals(withdrawals, bn('99098117948463825569871159'))
      assert.equals(elRewards, ETH(500000))
    })

    it('withdrawal finalization works after dry-run call', async () => {
      await setBalance(elRewardsVault, ETH(500000))
      await setBalance(withdrawalVault, ETH(500000))

      assert.equals(await withdrawalQueue.getLastFinalizedRequestId(), toBN(0))
      assert.isFalse(await withdrawalQueue.isPaused())

      await lido.approve(withdrawalQueue.address, StETH(1), { from: stranger })
      await withdrawalQueue.requestWithdrawals([StETH(1)], stranger, { from: stranger })
      assert.equals(await withdrawalQueue.unfinalizedStETH(), StETH(1))
      assert.equals(await withdrawalQueue.unfinalizedRequestNumber(), 1)

      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          maxPositiveTokenRebase: 10000000,
        },
        { from: voting, gasPrice: 1 }
      )

      await advanceChainTime(30)

      const [postTotalPooledEther, postTotalShares, ,] = await lido.handleOracleReport.call(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96100000),
          elRewardsVaultBalance: ETH(500000),
          withdrawalVaultBalance: ETH(500000),
        }),
        { from: oracle, gasPrice: 1 }
      )

      await advanceChainTime(30)

      const simulatedShareRate = postTotalPooledEther.mul(toBN(shareRate(1))).div(postTotalShares)
      const tooLowSimulatedShareRate = simulatedShareRate.mul(toBN(3)).div(toBN(4))

      await assert.reverts(
        lido.handleOracleReport(
          ...Object.values({
            ...DEFAULT_LIDO_ORACLE_REPORT,
            reportTimestamp: await getCurrentBlockTimestamp(),
            timeElapsed: ONE_DAY,
            clValidators: 3,
            postCLBalance: ETH(96100000),
            elRewardsVaultBalance: ETH(500000),
            withdrawalVaultBalance: ETH(500000),
            withdrawalFinalizationBatches: [1],
            simulatedShareRate: tooLowSimulatedShareRate,
          }),
          { from: oracle, gasPrice: 1 }
        ),
        `IncorrectSimulatedShareRate(${tooLowSimulatedShareRate.toString()}, ${simulatedShareRate.toString()})`
      )

      const tooHighSimulatedShareRate = simulatedShareRate.mul(toBN(3)).div(toBN(2))

      await assert.reverts(
        lido.handleOracleReport(
          ...Object.values({
            ...DEFAULT_LIDO_ORACLE_REPORT,
            reportTimestamp: await getCurrentBlockTimestamp(),
            timeElapsed: ONE_DAY,
            clValidators: 3,
            postCLBalance: ETH(96100000),
            elRewardsVaultBalance: ETH(500000),
            withdrawalVaultBalance: ETH(500000),
            withdrawalFinalizationBatches: [1],
            simulatedShareRate: tooHighSimulatedShareRate,
          }),
          { from: oracle, gasPrice: 1 }
        ),
        `IncorrectSimulatedShareRate(${tooHighSimulatedShareRate.toString()}, ${simulatedShareRate.toString()})`
      )

      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          reportTimestamp: await getCurrentBlockTimestamp(),
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96100000),
          elRewardsVaultBalance: ETH(500000),
          withdrawalVaultBalance: ETH(500000),
          withdrawalFinalizationBatches: [1],
          simulatedShareRate,
        }),
        { from: oracle, gasPrice: 1 }
      )

      assert.equals(await withdrawalQueue.getLastFinalizedRequestId(), toBN(1))
      await withdrawalQueue.claimWithdrawal(1, { from: stranger })
    })

    it('check simulated share rate correctness when limit is higher due to withdrawals', async () => {
      // Execution layer rewards and withdrawal vault balance to report
      // NB: both don't exceed daily rebase by themselves
      await setBalance(elRewardsVault, ETH(250000))
      await setBalance(withdrawalVault, ETH(500000))

      // Bob decides to burn stETH amount corresponding to ETH(1)
      await lido.submit(ZERO_ADDRESS, { from: bob, value: ETH(1000000) })
      const sharesRequestedToBurn = await lido.sharesOf(bob)
      await lido.approve(burner.address, await lido.balanceOf(bob), { from: bob })
      await burner.requestBurnShares(bob, sharesRequestedToBurn, { from: voting })

      // Check that we haven't finalized anything yet
      assert.equals(await withdrawalQueue.getLastFinalizedRequestId(), toBN(0))
      assert.isFalse(await withdrawalQueue.isPaused())

      // Stranger decides to withdraw his stETH(1)
      await lido.approve(withdrawalQueue.address, StETH(1000000), { from: stranger })
      await withdrawalQueue.requestWithdrawals([StETH(1000000)], stranger, { from: stranger })
      assert.equals(await withdrawalQueue.unfinalizedStETH(), StETH(1000000))
      assert.equals(await withdrawalQueue.unfinalizedRequestNumber(), 1)

      // Setting daily positive rebase as 1%
      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          maxPositiveTokenRebase: 10000000,
        },
        { from: voting, gasPrice: 1 }
      )

      await advanceChainTime(30)

      // Performing dry-run to estimate simulated share rate
      const [postTotalPooledEther, postTotalShares, withdrawals, elRewards] = await lido.handleOracleReport.call(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96100000),
          elRewardsVaultBalance: ETH(250000),
          withdrawalVaultBalance: ETH(500000),
          sharesRequestedToBurn: sharesRequestedToBurn.toString(),
        }),
        { from: oracle, gasPrice: 1 }
      )

      assert.equals(withdrawals.add(elRewards), ETH(750000))
      // Ensuring that vaults don't hit the positive rebase limit
      assert.equals(await getBalance(elRewardsVault), elRewards)
      assert.equals(await getBalance(withdrawalVault), withdrawals)
      const simulatedShareRate = postTotalPooledEther.mul(toBN(shareRate(1))).div(postTotalShares)

      await advanceChainTime(30)

      // Bob decides to stake in between reference slot and real report submission
      await lido.submit(ZERO_ADDRESS, { from: bob, value: ETH(1137000) })
      await lido.submit(ZERO_ADDRESS, { from: bob, value: ETH(170000) })
      await lido.submit(ZERO_ADDRESS, { from: bob, value: ETH(839000) })

      // Sending the real report with finalization attempts
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          reportTimestamp: await getCurrentBlockTimestamp(),
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96100000),
          elRewardsVaultBalance: ETH(250000),
          withdrawalVaultBalance: ETH(500000),
          sharesRequestedToBurn: sharesRequestedToBurn.toString(),
          withdrawalFinalizationBatches: [1],
          simulatedShareRate: simulatedShareRate.toString(),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96100000) })

      // Checking that both vaults are withdrawn
      assert.equals(await getBalance(elRewardsVault), toBN(0))
      assert.equals(await getBalance(withdrawalVault), toBN(0))
      // But have excess shares to burn later
      let { coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn()
      assert.isTrue(sharesRequestedToBurn.gt(coverShares.add(nonCoverShares)))
      assert.isTrue(coverShares.add(nonCoverShares).gt(toBN(0)))
      // Check total pooled ether
      const totalPooledEtherAfterFinalization = await lido.getTotalPooledEther()
      // Add Bob's recently staked funds, deduct finalized with 1:1 stranger's StETH(1)
      assert.equals(
        totalPooledEtherAfterFinalization,
        postTotalPooledEther.add(toBN(ETH(1137000 + 170000 + 839000 - 1000000)))
      )

      // Checking that finalization of the previously placed withdrawal request completed
      assert.equals(await withdrawalQueue.getLastFinalizedRequestId(), toBN(1))
      const strangerBalanceBeforeClaim = await getBalance(stranger)
      await withdrawalQueue.claimWithdrawal(1, { from: stranger, gasPrice: 0 })
      const strangerBalanceAfterClaim = await getBalance(stranger)
      // Happy-path: user receive ETH corresponding to the requested StETH amount
      assert.equals(strangerBalanceAfterClaim - strangerBalanceBeforeClaim, StETH(1000000))

      // Reporting once again allowing shares to be burnt completely
      await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          reportTimestamp: await getCurrentBlockTimestamp(),
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96100000),
          elRewardsVaultBalance: ETH(0),
          withdrawalVaultBalance: ETH(0),
          sharesRequestedToBurn: coverShares.add(nonCoverShares).toString(),
        }),
        { from: oracle, gasPrice: 1 }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96100000) })
      // Checking that no shares to burn remain
      ;({ coverShares, nonCoverShares } = await burner.getSharesRequestedToBurn())
      assert.equals(coverShares, toBN(0))
      assert.equals(nonCoverShares, toBN(0))
    })

    it('simulatedShareRate is higher due to outstanding submits if token rebase is positive', async () => {
      //  Some EL rewards to report
      await setBalance(elRewardsVault, ETH(1000000))

      // Check that we haven't finalized anything yet
      assert.equals(await withdrawalQueue.getLastFinalizedRequestId(), toBN(0))
      assert.isFalse(await withdrawalQueue.isPaused())

      // Stranger decides to withdraw his stETH(10)
      await lido.approve(withdrawalQueue.address, StETH(10), { from: stranger })
      await withdrawalQueue.requestWithdrawals([StETH(10)], stranger, { from: stranger })
      assert.equals(await withdrawalQueue.unfinalizedStETH(), StETH(10))
      assert.equals(await withdrawalQueue.unfinalizedRequestNumber(), 1)

      const maxPositiveTokenRebase = 1000000000 // Setting daily positive rebase as 100%
      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          churnValidatorsPerDayLimit: 100,
          maxPositiveTokenRebase,
        },
        { from: voting, gasPrice: 1 }
      )

      await advanceChainTime(30)

      // Performing dry-run to estimate simulated share rate
      const [postTotalPooledEther, postTotalShares, withdrawals, elRewards] = await lido.handleOracleReport.call(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96100000),
          elRewardsVaultBalance: ETH(1000000),
        }),
        { from: oracle, gasPrice: 1 }
      )
      const { elBalanceUpdate } = limitRebase(
        toBN(maxPositiveTokenRebase),
        ETH(100000001),
        ETH(100000001),
        ETH(100000),
        ETH(1000000),
        StETH(0)
      )
      assert.equals(withdrawals.add(elRewards), elBalanceUpdate)
      // Ensuring that the EL vault didn't hit the positive rebase limit
      assert.equals(await getBalance(elRewardsVault), elRewards)
      const simulatedShareRate = postTotalPooledEther.mul(toBN(shareRate(1))).div(postTotalShares)

      await advanceChainTime(30)

      // Bob decides to stake rather massive amount in between reference slot and real report submission
      await lido.submit(ZERO_ADDRESS, { from: bob, value: ETH(10000000) })

      // Sending the real report with finalization attempts
      const [realPostTotalPooledEther, realPostTotalShares] = await lido.handleOracleReport.sendWithResult(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          reportTimestamp: await getCurrentBlockTimestamp(),
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(96100000),
          elRewardsVaultBalance: ETH(1000000),
          withdrawalFinalizationBatches: [1],
          simulatedShareRate: simulatedShareRate.toString(),
        }),
        { from: oracle, gasPrice: 1 }
      )
      const realShareRate = realPostTotalPooledEther.mul(toBN(shareRate(1))).div(realPostTotalShares)

      // simulated share rate is greater than the really reported
      assert.isTrue(simulatedShareRate.gt(realShareRate))

      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96100000) })

      // Checking that both vaults are withdrawn
      assert.equals(await getBalance(elRewardsVault), toBN(0))
      assert.equals(await getBalance(withdrawalVault), toBN(0))
      // Check total pooled ether
      const totalPooledEtherAfterFinalization = await lido.getTotalPooledEther()
      // Add Bob's recently staked funds, deduct finalized with 1:1 stranger's StETH(10)
      assert.equals(totalPooledEtherAfterFinalization, ETH(110099991))

      // Checking that finalization of the previously placed withdrawal request completed
      assert.equals(await withdrawalQueue.getLastFinalizedRequestId(), toBN(1))
      const strangerBalanceBeforeClaim = await getBalance(stranger)
      await withdrawalQueue.claimWithdrawal(1, { from: stranger, gasPrice: 0 })
      const strangerBalanceAfterClaim = await getBalance(stranger)
      // Happy-path: user receive ETH corresponding to the requested StETH amount
      assert.equals(strangerBalanceAfterClaim - strangerBalanceBeforeClaim, StETH(10))
    })

    it('simulatedShareRate is lower due to outstanding submits if token rebase is negative', async () => {
      // Check that we haven't finalized anything yet
      assert.equals(await withdrawalQueue.getLastFinalizedRequestId(), toBN(0))
      assert.isFalse(await withdrawalQueue.isPaused())

      // Stranger decides to withdraw his stETH(10)
      await lido.approve(withdrawalQueue.address, StETH(10), { from: stranger })
      await withdrawalQueue.requestWithdrawals([StETH(10)], stranger, { from: stranger })
      assert.equals(await withdrawalQueue.unfinalizedStETH(), StETH(10))
      assert.equals(await withdrawalQueue.unfinalizedRequestNumber(), 1)

      await advanceChainTime(30)

      // Performing dry-run to estimate simulated share rate
      const [postTotalPooledEther, postTotalShares] = await lido.handleOracleReport.call(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(95), // CL rebase is negative (was 96 ETH before the report)
        }),
        { from: oracle, gasPrice: 1 }
      )
      const simulatedShareRate = postTotalPooledEther.mul(toBN(shareRate(1))).div(postTotalShares)

      await advanceChainTime(30)

      // Bob decides to stake rather massive amount in between reference slot and real report submission
      await lido.submit(ZERO_ADDRESS, { from: bob, value: ETH(10) })

      // Sending the real report with finalization attempts
      const [realPostTotalPooledEther, realPostTotalShares] = await lido.handleOracleReport.sendWithResult(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          reportTimestamp: await getCurrentBlockTimestamp(),
          timeElapsed: ONE_DAY,
          clValidators: 3,
          postCLBalance: ETH(95),
          withdrawalFinalizationBatches: [1],
          simulatedShareRate: simulatedShareRate.toString(),
        }),
        { from: oracle, gasPrice: 1 }
      )
      const realShareRate = realPostTotalPooledEther.mul(toBN(shareRate(1))).div(realPostTotalShares)

      // simulated share rate is lower than the really reported
      assert.isTrue(simulatedShareRate.lt(realShareRate))

      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(95) })

      // Checking that finalization of the previously placed withdrawal request completed
      assert.equals(await withdrawalQueue.getLastFinalizedRequestId(), toBN(1))
      await withdrawalQueue.claimWithdrawal(1, { from: stranger, gasPrice: 0 })
    })
  })

  describe('100% of rewards receive staking module & treasury', () => {
    beforeEach(async () => {
      await lido.deposit(3, 1, '0x', { from: depositor })
      await checkStat({ depositedValidators: 3, beaconValidators: 0, beaconBalance: 0 })
      await checkBalanceDeltas({
        totalPooledEtherDiff: 0,
        treasuryBalanceDiff: 0,
        strangerBalanceDiff: 0,
        anotherStrangerBalanceDiff: 0,
        curatedModuleBalanceDiff: 0,
        initialHolderBalanceDiff: 0,
      })
      const curatedModuleId = 1
      await deployed.stakingRouter.updateStakingModule(curatedModuleId, 100_00, 50_00, 50_00, { from: voting })
      const curatedModuleStats = await deployed.stakingRouter.getStakingModule(curatedModuleId)
      assert.equals(curatedModuleStats.stakingModuleFee, 50_00)
      assert.equals(curatedModuleStats.treasuryFee, 50_00)
    })

    it('oracle report handled correctly', async () => {
      // set annualBalanceIncreaseBPLimit = 1%
      await oracleReportSanityChecker.setOracleReportLimits(
        {
          ...ORACLE_REPORT_LIMITS_BOILERPLATE,
          annualBalanceIncreaseBPLimit: 100,
        },
        { from: voting }
      )

      await lido.handleOracleReport(
        ...Object.values({ ...DEFAULT_LIDO_ORACLE_REPORT, clValidators: 3, postCLBalance: ETH(96000000) }),
        { from: oracle }
      )
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96000000) })
      await checkBalanceDeltas({
        totalPooledEtherDiff: 0,
        treasuryBalanceDiff: 0,
        strangerBalanceDiff: 0,
        anotherStrangerBalanceDiff: 0,
        curatedModuleBalanceDiff: 0,
        initialHolderBalanceDiff: 0,
      })
      const tx = await lido.handleOracleReport(
        ...Object.values({
          ...DEFAULT_LIDO_ORACLE_REPORT,
          timeElapsed: ONE_YEAR,
          clValidators: 3,
          postCLBalance: ETH(96960000),
        }),
        { from: oracle }
      )
      const sharesMintedAsFees = calcSharesMintedAsFees(
        ETH(960000), // rewards
        100, // fee
        100, // feePoints
        ETH(100000000), // prevTotalShares
        ETH(100960000) // newTotalEther
      )
      await checkEvents({
        tx,
        preCLValidators: 3,
        postCLValidators: 3,
        preCLBalance: ETH(96000000),
        postCLBalance: ETH(96960000),
        withdrawalsWithdrawn: 0,
        executionLayerRewardsWithdrawn: 0,
        postBufferedEther: ETH(3000001),
        timeElapsed: ONE_YEAR,
        preTotalShares: ETH(99000001),
        preTotalEther: ETH(99000001),
        postTotalShares: toBN(ETH(99000001)).add(sharesMintedAsFees).toString(),
        postTotalEther: ETH(99960001),
        sharesMintedAsFees: sharesMintedAsFees.toString(),
      })
      await checkStat({ depositedValidators: 3, beaconValidators: 3, beaconBalance: ETH(96960000) })
    })
  })
})
