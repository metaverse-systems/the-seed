#pragma once

#include <libecs-cpp/ecs.hpp>

class SKELETON_ : public ecs::System
{
  public:
    SKELETON_(); 
    SKELETON_(nlohmann::json);
    nlohmann::json Export();
    void Update();
    void Init();
};
