// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "../../src/AssetLicenseRegistry.sol";

/// @dev Well-behaved ERC-721 receiver: returns the magic selector.
contract GoodReceiver is IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @dev Returns the wrong selector, so a safe transfer must revert.
contract WrongSelectorReceiver {
    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xdeadbeef;
    }
}

/// @dev Has no onERC721Received at all; the call reverts and the transfer fails.
contract NonReceiver {
    uint256 public calls;

    function ping() external {
        calls += 1;
    }
}
