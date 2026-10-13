// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AssetLicenseRegistry} from "../src/AssetLicenseRegistry.sol";

/**
 * @title Deploy
 * @notice Deploys AssetLicenseRegistry to the local Anvil chain and grants the
 *         platform signer the on-chain publisher role (SRS §9.3).
 *
 * Local development only: the publisher key is a deterministic Anvil test
 * account, and no token minted here has any economic value (§2.7, §3.9.1).
 *
 * Usage (see packages/contracts/scripts/docker-deploy.sh):
 *   DEPLOYER_PRIVATE_KEY=0x... PUBLISHER_ADDRESS=0x... \
 *     forge script script/Deploy.s.sol:Deploy --rpc-url $ANVIL_RPC_URL --broadcast
 */
contract Deploy {
    function run() external returns (AssetLicenseRegistry registry) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address publisher = vm.envAddress("PUBLISHER_ADDRESS");

        vm.startBroadcast(deployerKey);
        registry = new AssetLicenseRegistry(publisher);
        vm.stopBroadcast();
    }

    // Minimal cheatcode surface so this script has no forge-std dependency,
    // keeping `forge script` runnable offline.
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
}

interface Vm {
    function envUint(string calldata name) external view returns (uint256);
    function envAddress(string calldata name) external view returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}
