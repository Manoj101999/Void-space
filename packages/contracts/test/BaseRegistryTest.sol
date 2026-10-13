// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AssetLicenseRegistry} from "../src/AssetLicenseRegistry.sol";

/// @dev Shared fixture for the AssetLicenseRegistry suites (SRS §9.5).
abstract contract BaseRegistryTest is Test {
    AssetLicenseRegistry internal registry;

    // The deployment owner (platform operator, §3.9.2).
    address internal constant OWNER = address(0xA11CE);
    // The tenant's managed "publisher" signer — the address the worker signs with.
    address internal constant PUBLISHER = address(0xB0B);
    // A license recipient (a linked user wallet, §3.9.3).
    address internal constant HOLDER = address(0xC0FFEE);
    // An unrelated third party, used for negative access-control tests.
    address internal constant STRANGER = address(0xDEAD);

    string internal constant ASSET_ID = "0f5b1c2e-6a1d-4a0e-9c3b-9f7a2d4e8b11";
    string internal constant CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    string internal constant TERMS_HASH = "0x9f2b7c1d4e6a8b0c2d4f6a8b0c2d4f6a8b0c2d4f6a8b0c2d4f6a8b0c2d4f6a8b";
    string internal constant METADATA_CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

    uint64 internal constant MINT_TIMESTAMP = 1_760_000_000;

    function setUp() public virtual {
        vm.warp(MINT_TIMESTAMP);
        registry = new AssetLicenseRegistry(OWNER);
        vm.prank(OWNER);
        registry.setPublisher(PUBLISHER, true);
    }

    /// @dev Convenience mint performed as the platform publisher signer.
    function _mintAsPublisher() internal returns (uint256 tokenId) {
        vm.prank(PUBLISHER);
        tokenId = registry.mintLicense(HOLDER, ASSET_ID, CID, TERMS_HASH);
    }

    /// @dev Mints and attaches the metadata document CID, i.e. the full happy path.
    function _mintWithMetadata() internal returns (uint256 tokenId) {
        tokenId = _mintAsPublisher();
        vm.prank(PUBLISHER);
        registry.setLicenseMetadataCid(tokenId, METADATA_CID);
    }
}
