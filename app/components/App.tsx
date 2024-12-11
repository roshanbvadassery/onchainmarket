"use client";

import { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Upload, Award, CheckCircle2, Timer } from "lucide-react";
import { createClient } from '@supabase/supabase-js';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { ethers } from 'ethers';
import { uploadImage } from '../utils/camera';

// Initialize Supabase client
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// Contract configuration
const CONTRACT_ADDRESS = "0x589c0d954dce1f993780bce369dcd21c559bae24";
const CONTRACT_ABI = [
  "function createBounty(string memory requirements) external payable",
  "function submitGraphic(uint256 bountyId, string memory submissionUrl) external payable",
  "function getBounty(uint256 bountyId) external view returns (address creator, string requirements, uint256 reward, bool isActive, address winner, string winningSubmission)",
  "function getOracleFee() external view returns (uint256)",
  "event BountyCreated(uint256 indexed bountyId, address indexed creator, string requirements, uint256 reward)",
  "event SubmissionMade(uint256 indexed bountyId, address indexed submitter, string submissionUrl)",
  "event SubmissionResult(uint256 indexed bountyId, address indexed submitter, bool isAccepted, uint8 score)",
  "event BountyCompleted(uint256 indexed bountyId, address indexed winner, string winningSubmission, uint256 reward)"
];

// Base network configuration
const BASE_CHAIN_ID = 8453;
const BASE_CONFIG = {
  chainId: BASE_CHAIN_ID,
  name: 'Base',
  rpcUrls: {
    default: 'https://mainnet.base.org',
    public: 'https://mainnet.base.org',
  },
  blockExplorers: {
    default: { name: 'BaseScan', url: 'https://basescan.org' },
  },
  nativeCurrency: {
    name: 'Ethereum',
    symbol: 'ETH',
    decimals: 18,
  },
};

interface Bounty {
  id: number;
  creator: string;
  requirements: string;
  reward: string;
  isActive: boolean;
  winner?: string;
  winningSubmission?: string;
  submissions: Submission[];
}

interface Submission {
  bountyId: number;
  submitter: string;
  imageUrl: string;
  timestamp: string;
  status: 'pending' | 'accepted' | 'rejected';
  score?: number;
}

const Market = () => {
  const { login, authenticated, user, logout } = usePrivy();
  const { wallets } = useWallets();
  const [contract, setContract] = useState<ethers.Contract | null>(null);
  const [bounties, setBounties] = useState<Bounty[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [uploadStatus, setUploadStatus] = useState<string>('');
  const [newBountyRequirements, setNewBountyRequirements] = useState<string>('');
  const [newBountyReward, setNewBountyReward] = useState<string>('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedBountyId, setSelectedBountyId] = useState<number | null>(null);
  const [isLoadingBounties, setIsLoadingBounties] = useState(true);

  // Add a separate function to load bounties
  const loadBounties = async () => {
    try {
      setIsLoadingBounties(true);
      const { data: existingBounties, error } = await supabase
        .from('bounties')
        .select('*')
        .order('created_at', { ascending: false });
      
      if (error) throw error;
      
      if (existingBounties) {
        const formattedBounties: Bounty[] = await Promise.all(existingBounties.map(async (bounty) => {
          let isActive = bounty.is_active;
          console.log(`Bounty ${bounty.id} DB status:`, isActive);
          
          if (contract) {
            try {
              const onChainBounty = await contract.getBounty(bounty.id);
              isActive = onChainBounty.isActive;
              console.log(`Bounty ${bounty.id} Chain status:`, isActive);
            } catch (err) {
              console.error(`Error fetching bounty ${bounty.id} status:`, err);
            }
          }

          return {
            id: bounty.id,
            creator: bounty.creator,
            requirements: bounty.requirements,
            reward: ethers.utils.formatEther(bounty.reward),
            isActive: isActive,
            winner: bounty.winner || undefined,
            winningSubmission: bounty.winning_submission || undefined,
            submissions: bounty.submissions || []
          };
        }));
        
        console.log('Final formatted bounties:', formattedBounties);
        setBounties(formattedBounties);
      }
    } catch (error) {
      console.error('Error loading bounties:', error);
      setUploadStatus('Failed to load bounties');
    } finally {
      setIsLoadingBounties(false);
    }
  };

  // Modify the useEffect to handle duplicate bounties
  useEffect(() => {
    const initContract = async () => {
      if (!authenticated || wallets.length === 0) return;
      
      try {
        const wallet = wallets[0];
        const provider = await wallet.getEthersProvider();
        
        if (!provider) throw new Error('Failed to get provider');

        const network = await provider.getNetwork();
        
        if (network.chainId !== BASE_CHAIN_ID) {
          await wallet.switchChain(BASE_CHAIN_ID);
        }

        const signer = provider.getSigner();
        const graphicsContract = new ethers.Contract(
          CONTRACT_ADDRESS,
          CONTRACT_ABI,
          signer
        );
        
        setContract(graphicsContract);

        // Load existing bounties first
        await loadBounties();

        // Set up event listeners
        graphicsContract.on("BountyCreated", 
          async (bountyId, creator, requirements, reward) => {
            // Check if bounty already exists before adding
            const bountyExists = bounties.some(b => b.id === bountyId.toNumber());
            if (bountyExists) return;
            
            const newBounty: Bounty = {
              id: bountyId.toNumber(),
              creator,
              requirements,
              reward: ethers.utils.formatEther(reward),
              isActive: true,
              submissions: []
            };
            
            // Save to Supabase
            await supabase.from('bounties').insert({
              id: newBounty.id,
              creator: newBounty.creator,
              requirements: newBounty.requirements,
              reward: reward.toString(),
              is_active: true,
              created_at: new Date().toISOString()
            });
            
            setBounties(prev => [newBounty, ...prev]);
          }
        );

        graphicsContract.on("SubmissionResult",
          (bountyId, submitter, isAccepted, score) => {
            setBounties(prev => prev.map(bounty => {
              if (bounty.id === bountyId.toNumber()) {
                const updatedSubmissions = bounty.submissions.map(sub => {
                  if (sub.submitter === submitter) {
                    return {
                      ...sub,
                      status: isAccepted ? ('accepted' as const) : ('rejected' as const),
                      score: score
                    };
                  }
                  return sub;
                });
                return { ...bounty, submissions: updatedSubmissions };
              }
              return bounty;
            }));
          }
        );

      } catch (error) {
        console.error('Error initializing contract:', error);
        setUploadStatus('Failed to connect to Base network');
      }
    };

    initContract();

    return () => {
      if (contract) {
        contract.removeAllListeners();
      }
    };
  }, [authenticated, wallets]);

  const createBounty = async () => {
    if (!contract || !newBountyRequirements || !newBountyReward) return;
    
    setLoading(true);
    setUploadStatus('Creating bounty...');
    
    try {
      const reward = ethers.utils.parseEther(newBountyReward);
      const tx = await contract.createBounty(newBountyRequirements, {
        value: reward,
        gasLimit: 500000
      });
      
      await tx.wait();
      
      setNewBountyRequirements('');
      setNewBountyReward('');
      setUploadStatus('Bounty created successfully!');
    } catch (error) {
      console.error('Error creating bounty:', error);
      setUploadStatus('Failed to create bounty');
    } finally {
      setLoading(false);
      setTimeout(() => setUploadStatus(''), 3000);
    }
  };

  const submitToBounty = async (bountyId: number) => {
    if (!contract || !selectedFile) return;
    
    try {
      // Pre-submission checks
      const bounty = bounties.find(b => b.id === bountyId);
      if (!bounty) throw new Error('Bounty not found');
      if (!bounty.isActive) throw new Error('Bounty is not active');
      if (bounty.creator === user!.id) throw new Error('Cannot submit to your own bounty');
      if (bounty.submissions.some(s => s.submitter === user!.id)) {
        throw new Error('Already submitted to this bounty');
      }

      setLoading(true);
      setUploadStatus('Uploading submission...');
      
      const uploadResult = await uploadImage(selectedFile, user!.id, false);
      const oracleFee = 100000000000;
      
      setUploadStatus('Submitting to blockchain...');
      
      // Create a promise that will resolve when we get the SubmissionResult event
      const submissionResultPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          contract.removeAllListeners("SubmissionResult");
          reject(new Error("Submission timeout"));
        }, 300000); // 5 minute timeout

        contract.once("SubmissionResult", 
          (resultBountyId, submitter, isAccepted, score) => {
            if (resultBountyId.toNumber() === bountyId && submitter === user!.id) {
              clearTimeout(timeout);
              resolve({ isAccepted, score });
            }
        });
      });

      // Submit the transaction
      const tx = await contract.submitGraphic(
        bountyId, 
        uploadResult.url,
        {
          value: oracleFee,
          gasLimit: 1000000
        }
      );
      
      setUploadStatus('Waiting for AI verification...');
      
      // Wait for both transaction confirmation and submission result
      await tx.wait(1);
      const { isAccepted, score } = await submissionResultPromise as { isAccepted: boolean, score: number };

      // Update the UI based on the result
      setBounties(prev => prev.map(bounty => {
        if (bounty.id === bountyId) {
          const newSubmission: Submission = {
            bountyId,
            submitter: user!.id,
            imageUrl: uploadResult.url,
            timestamp: new Date().toISOString(),
            status: isAccepted ? 'accepted' : 'rejected',
            score
          };
          return {
            ...bounty,
            submissions: [...bounty.submissions, newSubmission],
            ...(isAccepted ? {
              isActive: false,
              winner: user!.id,
              winningSubmission: uploadResult.url
            } : {})
          };
        }
        return bounty;
      }));

      // Update Supabase
      const { data: existingBounty } = await supabase
        .from('bounties')
        .select('submissions')
        .eq('id', bountyId)
        .single();

      const submissions = [
        ...(existingBounty?.submissions || []),
        {
          bountyId,
          submitter: user!.id,
          imageUrl: uploadResult.url,
          timestamp: new Date().toISOString(),
          status: isAccepted ? 'accepted' : 'rejected',
          score
        }
      ];

      await supabase
        .from('bounties')
        .update({ 
          submissions,
          ...(isAccepted ? {
            is_active: false,
            winner: user!.id,
            winning_submission: uploadResult.url
          } : {})
        })
        .eq('id', bountyId);
      
      setSelectedFile(null);
      setUploadStatus(isAccepted ? 
        `Submission accepted with score ${score}/10!` : 
        `Submission rejected with score ${score}/10`
      );
    } catch (error: any) {
      console.error('Error submitting to bounty:', error);
      let errorMessage = error.message;
      if (error.error?.data?.message) {
        errorMessage = error.error.data.message.replace('execution reverted: ', '');
      }
      setUploadStatus(`Failed to submit: ${errorMessage}`);
    } finally {
      setLoading(false);
      setTimeout(() => setUploadStatus(''), 5000);
    }
  };

  return (
    <div className="min-h-screen bg-[#e0e0e0] font-['Helvetica']">
      <div className="container mx-auto px-4 py-8 max-w-[1200px]">
        {/* Header Card - Leather texture */}
        <div className="bg-[#8B4513] rounded-2xl p-8 mb-12 shadow-[inset_0_0_10px_rgba(0,0,0,0.6)] border-4 border-[#5C2E0B] relative"
             style={{
               background: 'linear-gradient(45deg, #8B4513, #A0522D)',
               boxShadow: 'inset 0 2px 3px rgba(255,255,255,0.3), inset 0 -2px 3px rgba(0,0,0,0.3), 0 2px 4px rgba(0,0,0,0.4)'
             }}>
          <h1 className="text-5xl font-extrabold text-[#FFD700] text-center mb-6"
              style={{
                textShadow: '2px 2px 4px rgba(0,0,0,0.5)',
                WebkitTextStroke: '1px #B8860B'
              }}>
            Onchain Market 🎨
          </h1>
          <p className="text-lg font-semibold text-[#FFE4B5] text-center bg-[#5C2E0B] rounded-xl p-3"
             style={{
               boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.5)'
             }}>
            Create bounties for graphics or submit your work to earn ETH!
          </p>
          {authenticated && (
            <div className="text-center mt-4">
              <Button
                onClick={logout}
                className="bg-[#CD853F] hover:bg-[#DEB887] text-[#3E1F0D] font-bold px-6 py-3 rounded-xl transition-all duration-200"
                style={{
                  boxShadow: '0 4px 6px rgba(0,0,0,0.3), inset 0 2px 3px rgba(255,255,255,0.2)'
                }}
              >
                Disconnect Wallet
              </Button>
            </div>
          )}
        </div>

        {authenticated ? (
          <>
            {/* Create Bounty Section - Paper texture */}
            <div className="bg-[#FFF5E1] rounded-2xl p-6 mb-8 relative"
                 style={{
                   boxShadow: '0 4px 8px rgba(0,0,0,0.2), inset 0 2px 3px rgba(255,255,255,0.5)',
                   background: 'linear-gradient(45deg, #FFF5E1, #FFF8E7)'
                 }}>
              <h2 className="text-3xl font-bold mb-4 text-[#4A3728]"
                  style={{
                    textShadow: '1px 1px 2px rgba(0,0,0,0.2)'
                  }}>
                Create New Bounty
              </h2>
              <Textarea
                placeholder="Describe your requirements..."
                value={newBountyRequirements}
                onChange={(e) => setNewBountyRequirements(e.target.value)}
                className="mb-4 bg-[#FFFAF0] border-2 border-[#DEB887] text-[#4A3728] placeholder:text-[#B8860B] rounded-xl"
                style={{
                  boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.1)'
                }}
              />
              <Input
                type="number"
                placeholder="Reward in ETH"
                value={newBountyReward}
                onChange={(e) => setNewBountyReward(e.target.value)}
                className="mb-4 bg-[#FFFAF0] border-2 border-[#DEB887] text-[#4A3728] placeholder:text-[#B8860B] rounded-xl"
                style={{
                  boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.1)'
                }}
              />
              <Button
                onClick={createBounty}
                disabled={loading}
                className="bg-[#CD853F] hover:bg-[#DEB887] text-[#3E1F0D] font-bold px-6 py-3 rounded-xl transition-all duration-200"
                style={{
                  boxShadow: '0 4px 6px rgba(0,0,0,0.3), inset 0 2px 3px rgba(255,255,255,0.2)'
                }}
              >
                <Plus className="mr-2" />
                Create Bounty
              </Button>
            </div>

            {/* Bounties Section - Cork board texture */}
            <div className="mb-6">
              <h2 className="text-3xl font-bold mb-4 text-[#4A3728]"
                  style={{
                    textShadow: '1px 1px 2px rgba(0,0,0,0.2)'
                  }}>
                Active Bounties
              </h2>
              {isLoadingBounties ? (
                <div className="text-center py-8 text-white">
                  <div className="animate-spin text-4xl mb-4">🎨</div>
                  <p>Loading bounties...</p>
                </div>
              ) : bounties.length === 0 ? (
                <div className="text-center py-8 backdrop-blur-lg bg-white/30 rounded-2xl border border-white/40">
                  <p className="text-xl font-bold text-white">No bounties yet!</p>
                  <p className="text-white/80">Be the first to create a bounty.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {bounties.map((bounty) => (
                    <div key={bounty.id} 
                         className="bg-[#FFF5E1] rounded-2xl p-6 relative"
                         style={{
                           boxShadow: '0 4px 8px rgba(0,0,0,0.3), inset 0 1px 3px rgba(255,255,255,0.5)',
                           transform: 'rotate(-1deg)',
                           background: 'linear-gradient(45deg, #FFF5E1, #FFF8E7)'
                         }}>
                      <div className="flex justify-between items-start mb-4">
                        <h3 className="text-xl font-bold text-[#4A3728]">Bounty #{bounty.id}</h3>
                        <span className={`px-3 py-1 rounded-full text-sm font-bold ${
                          bounty.isActive ? 'bg-green-600 text-white' : 'bg-gray-600 text-white'
                        }`}>
                          {bounty.isActive ? 'Active' : 'Completed'}
                        </span>
                      </div>
                      <p className="mb-2 text-[#4A3728]">{bounty.requirements}</p>
                      <p className="font-bold mb-4 text-[#8B4513]">Reward: {bounty.reward} ETH</p>
                      <p className="text-sm text-[#666666] mb-4">
                        Created by: {bounty.creator.slice(0, 6)}...{bounty.creator.slice(-4)}
                      </p>

                      {bounty.isActive && (
                        <div className="mt-4">
                          <input
                            type="file"
                            onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                            className="mb-4 text-[#4A3728]"
                            accept="image/*"
                          />
                          <Button
                            onClick={() => submitToBounty(bounty.id)}
                            disabled={loading || !selectedFile}
                            className="bg-[#CD853F] hover:bg-[#DEB887] text-[#3E1F0D] font-bold px-6 py-3 rounded-xl transition-all duration-200"
                            style={{
                              boxShadow: '0 4px 6px rgba(0,0,0,0.3), inset 0 2px 3px rgba(255,255,255,0.2)'
                            }}
                          >
                            <Upload className="mr-2" />
                            Submit
                          </Button>
                        </div>
                      )}

                      {bounty.submissions?.length > 0 && (
                        <div className="mt-6">
                          <h4 className="font-bold mb-2 text-[#4A3728]">Submissions</h4>
                          {bounty.submissions.map((submission, index) => (
                            <div key={index} className="mt-4 p-4 border-2 border-[#DEB887] rounded-lg bg-[#FFFAF0]">
                              <img src={submission.imageUrl} alt="Submission" className="w-full h-48 object-cover mb-2 rounded" />
                              <div className="flex justify-between items-center">
                                <p className="font-bold text-[#4A3728]">
                                  Status: {submission.status}
                                  {submission.score && ` (Score: ${submission.score}/10)`}
                                </p>
                                <p className="text-sm text-[#666666]">
                                  by: {submission.submitter.slice(0, 6)}...{submission.submitter.slice(-4)}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="text-center">
            <Button
              onClick={login}
              className="bg-[#CD853F] hover:bg-[#DEB887] text-[#3E1F0D] font-bold px-8 py-4 rounded-xl transition-all duration-200 transform hover:scale-105"
              style={{
                boxShadow: '0 4px 6px rgba(0,0,0,0.3), inset 0 2px 3px rgba(255,255,255,0.2)'
              }}
            >
              Connect Wallet to Start
            </Button>
          </div>
        )}

        {/* Loading Modal - Glass texture */}
        {loading && (
          <div className="fixed top-0 left-0 w-full h-full flex items-center justify-center bg-black/50 backdrop-blur-sm z-50">
            <div className="bg-[#FFF5E1]/90 rounded-2xl p-8 relative"
                 style={{
                   boxShadow: '0 8px 32px rgba(0,0,0,0.3), inset 0 2px 3px rgba(255,255,255,0.5)',
                   backdropFilter: 'blur(10px)'
                 }}>
              <div className="animate-spin text-4xl mb-4">🎨</div>
              <p className="font-bold text-[#4A3728]">{uploadStatus}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Market;
