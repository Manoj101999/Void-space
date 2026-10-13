// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseRegistryTest} from "./BaseRegistryTest.sol";
import {AssetLicenseRegistry} from "../src/AssetLicenseRegistry.sol";

/**
 * Licensing behaviour: mint, metadata pinning, revocation and the publisher
 * access-control gate (SRS §3.9.2, FR-9.2…FR-9.5).
 * Covers traceability cases TC-CHAIN-001 and TC-CHAIN-003 (Appendix A).
 */
contract AssetLicenseRegistryTest is BaseRegistryTest {
    event LicenseMinted(
        uint256 indexed tokenId,
        string assetId,
        string ipfsCid,
        string licenseTermsHash,
        address indexed approver,
        uint64 timestamp
    );
    event LicenseRevoked(uint256 indexed tokenId, string reason, uint64 timestamp);
    event LicenseMetadataUpdated(uint256 indexed tokenId, string metadataCid);

    function test_Constructor_SetsOwnerAndPublisher() public view {
        assertEq(registry.owner(), OWNER, "owner not set");
        assertTrue(registry.publishers(OWNER), "owner should be a publisher");
        assertTrue(registry.publishers(PUBLISHER), "publisher not granted");
        assertFalse(registry.publishers(STRANGER), "stranger must not be a publisher");
        assertEq(registry.totalMinted(), 0, "no tokens at deploy");
    }

    function test_MintLicense_StoresRecordAndEmitsDocumentedEvent() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit LicenseMinted(1, ASSET_ID, CID, TERMS_HASH, PUBLISHER, MINT_TIMESTAMP);

        uint256 tokenId = _mintAsPublisher();

        assertEq(tokenId, 1, "first tokenId must be 1");
        assertEq(registry.ownerOf(tokenId), HOLDER, "holder must own the license");
        assertEq(registry.balanceOf(HOLDER), 1, "balance not updated");
        assertEq(registry.totalMinted(), 1, "totalMinted not incremented");

        AssetLicenseRegistry.LicenseRecord memory record = registry.getLicense(tokenId);
        assertEq(record.assetId, ASSET_ID, "assetId mismatch");
        assertEq(record.ipfsCid, CID, "cid mismatch");
        assertEq(record.licenseTermsHash, TERMS_HASH, "terms hash mismatch");
        assertEq(record.mintedAt, MINT_TIMESTAMP, "mintedAt mismatch");
        assertFalse(record.revoked, "must not be revoked");
        assertFalse(record.metadataSet, "metadata not yet set");
        assertTrue(registry.isLicenseValid(tokenId), "fresh license must be valid");
    }

    /// TC-CHAIN-001 — minting is restricted to the platform publisher signer.
    function test_MintLicense_RevertsForNonPublisher() public {
        vm.prank(STRANGER);
        vm.expectRevert(AssetLicenseRegistry.NotPublisher.selector);
        registry.mintLicense(STRANGER, ASSET_ID, CID, TERMS_HASH);
    }

    function test_MintLicense_RevertsForZeroRecipient() public {
        vm.prank(PUBLISHER);
        vm.expectRevert(AssetLicenseRegistry.ZeroAddress.selector);
        registry.mintLicense(address(0), ASSET_ID, CID, TERMS_HASH);
    }

    function test_MintLicense_RevertsForEmptyAssetId() public {
        vm.prank(PUBLISHER);
        vm.expectRevert(
            abi.encodeWithSelector(AssetLicenseRegistry.EmptyField.selector, "assetId")
        );
        registry.mintLicense(HOLDER, "", CID, TERMS_HASH);
    }

    function test_MintLicense_RevertsForEmptyCid() public {
        vm.prank(PUBLISHER);
        vm.expectRevert(
            abi.encodeWithSelector(AssetLicenseRegistry.EmptyField.selector, "ipfsCid")
        );
        registry.mintLicense(HOLDER, ASSET_ID, "", TERMS_HASH);
    }

    function test_SetPublisher_GrantsAndRevokesMintRights() public {
        address newPublisher = address(0xF00D);
        vm.prank(OWNER);
        registry.setPublisher(newPublisher, true);
        assertTrue(registry.publishers(newPublisher), "should be a publisher");

        vm.prank(newPublisher);
        uint256 tokenId = registry.mintLicense(HOLDER, ASSET_ID, CID, TERMS_HASH);
        assertEq(tokenId, 1, "new publisher could not mint");

        vm.prank(OWNER);
        registry.setPublisher(newPublisher, false);

        vm.prank(newPublisher);
        vm.expectRevert(AssetLicenseRegistry.NotPublisher.selector);
        registry.mintLicense(HOLDER, ASSET_ID, CID, TERMS_HASH);
    }

    function test_SetPublisher_RevertsForNonOwner() public {
        vm.prank(STRANGER);
        vm.expectRevert(AssetLicenseRegistry.NotOwner.selector);
        registry.setPublisher(STRANGER, true);
    }

    // --------------------------------------------------------- metadata / tokenURI
    function test_SetLicenseMetadataCid_PublishesTokenURI() public {
        uint256 tokenId = _mintAsPublisher();

        vm.expectRevert(
            abi.encodeWithSelector(AssetLicenseRegistry.MetadataNotSet.selector, tokenId)
        );
        registry.tokenURI(tokenId);

        vm.prank(PUBLISHER);
        vm.expectEmit(true, false, false, true, address(registry));
        emit LicenseMetadataUpdated(tokenId, METADATA_CID);
        registry.setLicenseMetadataCid(tokenId, METADATA_CID);

        assertEq(
            registry.tokenURI(tokenId), string.concat("ipfs://", METADATA_CID), "tokenURI mismatch"
        );
        assertEq(registry.getLicense(tokenId).metadataCid, METADATA_CID, "record not updated");
    }

    function test_SetLicenseMetadataCid_RevertsWhenAlreadySet() public {
        uint256 tokenId = _mintWithMetadata();
        vm.prank(PUBLISHER);
        vm.expectRevert(
            abi.encodeWithSelector(AssetLicenseRegistry.MetadataAlreadySet.selector, tokenId)
        );
        registry.setLicenseMetadataCid(tokenId, METADATA_CID);
    }

    function test_SetLicenseMetadataCid_RevertsForUnknownToken() public {
        vm.prank(PUBLISHER);
        vm.expectRevert(
            abi.encodeWithSelector(AssetLicenseRegistry.TokenDoesNotExist.selector, 42)
        );
        registry.setLicenseMetadataCid(42, METADATA_CID);
    }

    function test_SetLicenseMetadataCid_RevertsForNonPublisher() public {
        uint256 tokenId = _mintAsPublisher();
        vm.prank(STRANGER);
        vm.expectRevert(AssetLicenseRegistry.NotPublisher.selector);
        registry.setLicenseMetadataCid(tokenId, METADATA_CID);
    }

    function test_TokenURI_RevertsForUnknownToken() public {
        vm.expectRevert(abi.encodeWithSelector(AssetLicenseRegistry.TokenDoesNotExist.selector, 7));
        registry.tokenURI(7);
    }

    // -------------------------------------------------------------- revocation
    /// TC-CHAIN-003 — revocation flags the record and never mutates the licensed
    /// content reference, so the licensed version stays provably unchanged (FR-9.4).
    function test_RevokeLicense_FlagsRecordWithoutErasingProvenance() public {
        uint256 tokenId = _mintWithMetadata();

        vm.prank(PUBLISHER);
        vm.expectEmit(true, false, false, true, address(registry));
        emit LicenseRevoked(tokenId, "takedown: quality regression", MINT_TIMESTAMP);
        registry.revokeLicense(tokenId, "takedown: quality regression");

        AssetLicenseRegistry.LicenseRecord memory record = registry.getLicense(tokenId);
        assertTrue(record.revoked, "must be flagged revoked");
        assertEq(record.revokedReason, "takedown: quality regression", "reason not stored");
        assertEq(record.revokedAt, MINT_TIMESTAMP, "revokedAt not stored");

        // The token still exists and its content anchor is byte-for-byte unchanged.
        assertEq(registry.ownerOf(tokenId), HOLDER, "token must not be burned");
        assertEq(record.ipfsCid, CID, "licensed CID must be immutable");
        assertEq(record.licenseTermsHash, TERMS_HASH, "terms must be immutable");
        assertEq(
            registry.tokenURI(tokenId), string.concat("ipfs://", METADATA_CID), "URI preserved"
        );
        assertFalse(registry.isLicenseValid(tokenId), "revoked license must be invalid");
    }

    function test_RevokeLicense_RevertsWhenAlreadyRevoked() public {
        uint256 tokenId = _mintAsPublisher();
        vm.startPrank(PUBLISHER);
        registry.revokeLicense(tokenId, "first");
        vm.expectRevert(
            abi.encodeWithSelector(AssetLicenseRegistry.LicenseAlreadyRevoked.selector, tokenId)
        );
        registry.revokeLicense(tokenId, "second");
        vm.stopPrank();
    }

    function test_RevokeLicense_RevertsForNonPublisher() public {
        uint256 tokenId = _mintAsPublisher();
        vm.prank(STRANGER);
        vm.expectRevert(AssetLicenseRegistry.NotPublisher.selector);
        registry.revokeLicense(tokenId, "unauthorised");
    }

    function test_GetLicense_RevertsForUnknownToken() public {
        vm.expectRevert(abi.encodeWithSelector(AssetLicenseRegistry.TokenDoesNotExist.selector, 99));
        registry.getLicense(99);
    }

    function test_IsLicenseValid_FalseForUnknownToken() public view {
        assertFalse(registry.isLicenseValid(1234), "unknown token cannot be valid");
    }

    function test_TransferOwnership_MovesAdminRights() public {
        vm.prank(OWNER);
        registry.transferOwnership(STRANGER);
        assertEq(registry.owner(), STRANGER, "ownership not transferred");

        vm.prank(OWNER);
        vm.expectRevert(AssetLicenseRegistry.NotOwner.selector);
        registry.setPublisher(OWNER, true);
    }

    /// Sequential minting never reuses a tokenId (provenance must stay unique).
    function testFuzz_MintLicense_AssignsSequentialUniqueIds(uint8 count) public {
        uint256 minted = bound(count, 1, 20);
        for (uint256 i = 1; i <= minted; i++) {
            assertEq(_mintAsPublisher(), i, "tokenId must be sequential");
        }
        assertEq(registry.totalMinted(), minted, "totalMinted mismatch");
    }
}
