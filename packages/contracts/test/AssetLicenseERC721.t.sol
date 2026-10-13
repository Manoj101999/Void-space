// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseRegistryTest} from "./BaseRegistryTest.sol";
import {AssetLicenseRegistry} from "../src/AssetLicenseRegistry.sol";
import {GoodReceiver, NonReceiver, WrongSelectorReceiver} from "./mocks/Receivers.sol";

/**
 * ERC-721 semantics of the licence token: ownership, approvals, transfers and
 * safe-transfer receiver checks. A license is a real, transferable token, so
 * these behaviours matter to downstream consumers (SRS §3.9.2, Appendix C).
 */
contract AssetLicenseERC721Test is BaseRegistryTest {
    function test_SupportsInterface() public view {
        assertTrue(registry.supportsInterface(0x01ffc9a7), "ERC-165");
        assertTrue(registry.supportsInterface(0x80ac58cd), "ERC-721");
        assertTrue(registry.supportsInterface(0x5b5e139f), "ERC-721 Metadata");
        assertFalse(registry.supportsInterface(0xffffffff), "unknown interface");
    }

    function test_Metadata_ReturnsDocumentedNameAndSymbol() public view {
        assertEq(registry.name(), "VOID SPACE Asset License", "name mismatch");
        assertEq(registry.symbol(), "VSAL", "symbol mismatch");
    }

    function test_OwnerOf_RevertsForUnknownToken() public {
        vm.expectRevert(abi.encodeWithSelector(AssetLicenseRegistry.TokenDoesNotExist.selector, 1));
        registry.ownerOf(1);
    }

    function test_BalanceOf_RevertsForZeroAddress() public {
        vm.expectRevert(AssetLicenseRegistry.ZeroAddress.selector);
        registry.balanceOf(address(0));
    }

    function test_TransferFrom_MovesOwnershipAndClearsApproval() public {
        uint256 tokenId = _mintAsPublisher();

        vm.prank(HOLDER);
        registry.approve(STRANGER, tokenId);
        assertEq(registry.getApproved(tokenId), STRANGER, "approval not recorded");

        vm.prank(STRANGER); // the approved spender may move the token
        registry.transferFrom(HOLDER, STRANGER, tokenId);

        assertEq(registry.ownerOf(tokenId), STRANGER, "ownership not transferred");
        assertEq(registry.balanceOf(HOLDER), 0, "sender balance not decremented");
        assertEq(registry.balanceOf(STRANGER), 1, "receiver balance not incremented");
        assertEq(registry.getApproved(tokenId), address(0), "approval must be cleared");

        // Revocation rights are role-based, so they are unaffected by transfers.
        vm.prank(PUBLISHER);
        registry.revokeLicense(tokenId, "still revocable after transfer");
        assertFalse(registry.isLicenseValid(tokenId), "license should be revoked");
    }

    function test_TransferFrom_RevertsForUnauthorizedCaller() public {
        uint256 tokenId = _mintAsPublisher();
        vm.prank(STRANGER);
        vm.expectRevert(AssetLicenseRegistry.NotAuthorized.selector);
        registry.transferFrom(HOLDER, STRANGER, tokenId);
    }

    function test_TransferFrom_RevertsForWrongFrom() public {
        uint256 tokenId = _mintAsPublisher();
        vm.prank(HOLDER);
        vm.expectRevert(AssetLicenseRegistry.NotAuthorized.selector);
        registry.transferFrom(STRANGER, HOLDER, tokenId);
    }

    function test_SetApprovalForAll_AllowsOperatorToTransfer() public {
        uint256 tokenId = _mintAsPublisher();

        vm.prank(HOLDER);
        registry.setApprovalForAll(STRANGER, true);
        assertTrue(registry.isApprovedForAll(HOLDER, STRANGER), "operator not approved");

        vm.prank(STRANGER);
        registry.transferFrom(HOLDER, STRANGER, tokenId);
        assertEq(registry.ownerOf(tokenId), STRANGER, "operator transfer failed");
    }

    function test_SetApprovalForAll_RevertsWhenApprovingSelf() public {
        vm.prank(HOLDER);
        vm.expectRevert(AssetLicenseRegistry.NotAuthorized.selector);
        registry.setApprovalForAll(HOLDER, true);
    }

    function test_SafeTransferFrom_ToReceiverContract() public {
        uint256 tokenId = _mintAsPublisher();
        GoodReceiver receiver = new GoodReceiver();

        vm.prank(HOLDER);
        registry.safeTransferFrom(HOLDER, address(receiver), tokenId);
        assertEq(registry.ownerOf(tokenId), address(receiver), "safe transfer failed");
    }

    function test_SafeTransferFrom_RevertsForWrongSelectorReceiver() public {
        uint256 tokenId = _mintAsPublisher();
        WrongSelectorReceiver receiver = new WrongSelectorReceiver();

        vm.prank(HOLDER);
        vm.expectRevert(AssetLicenseRegistry.UnsafeRecipient.selector);
        registry.safeTransferFrom(HOLDER, address(receiver), tokenId);
        assertEq(registry.ownerOf(tokenId), HOLDER, "ownership must not change on failure");
    }

    function test_SafeTransferFrom_RevertsForNonReceiverContract() public {
        uint256 tokenId = _mintAsPublisher();
        NonReceiver receiver = new NonReceiver();

        vm.prank(HOLDER);
        vm.expectRevert(AssetLicenseRegistry.UnsafeRecipient.selector);
        registry.safeTransferFrom(HOLDER, address(receiver), tokenId);
    }

    function test_SafeTransferFrom_ToEoaSucceeds() public {
        uint256 tokenId = _mintAsPublisher();
        vm.prank(HOLDER);
        registry.safeTransferFrom(HOLDER, STRANGER, tokenId);
        assertEq(registry.ownerOf(tokenId), STRANGER, "EOA safe transfer failed");
    }

    function test_Approve_RevertsForUnauthorizedCaller() public {
        uint256 tokenId = _mintAsPublisher();
        vm.prank(STRANGER);
        vm.expectRevert(AssetLicenseRegistry.NotAuthorized.selector);
        registry.approve(STRANGER, tokenId);
    }

    /// Ownership round-trips without corrupting balances.
    function testFuzz_Transfers_KeepBalancesConsistent(address to) public {
        vm.assume(to != address(0) && to != HOLDER && to.code.length == 0);
        uint256 tokenId = _mintAsPublisher();

        vm.prank(HOLDER);
        registry.transferFrom(HOLDER, to, tokenId);

        assertEq(registry.balanceOf(HOLDER), 0, "old owner balance must be zero");
        assertEq(registry.balanceOf(to), 1, "new owner balance must be one");
        assertEq(registry.ownerOf(tokenId), to, "ownership mismatch");
    }
}
