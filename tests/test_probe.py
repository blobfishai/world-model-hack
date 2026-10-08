from task_rooms.probe import CASES, VideoReview, task_prompt
from task_rooms.reactor_video import supported_commands


def test_cosmetic_change_cannot_pass_task_generation_gate():
    review = VideoReview(
        requested_action_visible=True, different_action_from_source=False,
        environment_preserved=True, object_identities_preserved=True,
        temporal_coherence=True, observed_actions="Original scrubbing action with a recolored plate.",
    )
    assert not review.passes()


def test_environment_drift_cannot_pass_task_generation_gate():
    review = VideoReview(
        requested_action_visible=True, different_action_from_source=True,
        environment_preserved=False, object_identities_preserved=True,
        temporal_coherence=True, observed_actions="Requested movement in a different kitchen.",
    )
    assert not review.passes()


def test_probe_covers_goal_sequence_and_difficulty():
    assert [case["id"] for case in CASES] == ["different-goal", "additional-step", "harder-task"]
    assert all(case["task"] in task_prompt(case["task"]) for case in CASES)


def test_live_only_deployment_is_not_sent_documented_file_commands():
    schema = {"paths": {"/events/start": {"post": {"operationId": "start"}},
                        "/events/set_prompt": {"post": {"operationId": "set_prompt"}}}}
    assert "start" in supported_commands(schema)
    assert "set_video" not in supported_commands(schema)
